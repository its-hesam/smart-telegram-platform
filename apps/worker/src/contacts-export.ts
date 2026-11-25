import { open, mkdir, chmod, rename, rm, stat, writeFile, type FileHandle } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
import { z } from 'zod';
import type { PrismaClient } from '../../../packages/database/src/index.js';
import type { Prisma } from '../../../packages/database/generated/client/client.js';
import type { FieldCipher } from '../../../packages/shared/src/crypto.js';
import { contactCsv, contactExportJobSchema, contactExportRow, contactWorkbook, type ContactExportRow } from '../../../packages/shared/src/contact-export.js';

class ExportCancelled extends Error {}

async function writeAll(handle: FileHandle, text: string) {
  const data = Buffer.from(text);
  let offset = 0;
  while (offset < data.length) {
    const { bytesWritten } = await handle.write(data, offset, data.length - offset);
    if (!bytesWritten) throw new Error('EXPORT_WRITE_STALLED');
    offset += bytesWritten;
  }
}

const checkpointSchema = z.object({
  lastId: z.string().optional(),
  bytes: z.number().int().nonnegative().optional(),
  processed: z.number().int().nonnegative().optional(),
});

export async function processContactsExport(db: PrismaClient, cipher: FieldCipher, jobId: string, ownerId: string, signal: AbortSignal, exportRoot: string, batchSize: number) {
  const claimed = await db.job.updateMany({
    where: { id: jobId, type: 'DATA_EXPORT', status: 'PENDING', cancellationRequestedAt: null },
    data: { status: 'RUNNING', workerId: ownerId, startedAt: new Date(), attemptCount: { increment: 1 } },
  });
  if (!claimed.count) return;

  const job = await db.job.findUniqueOrThrow({ where: { id: jobId } });
  let params: z.infer<typeof contactExportJobSchema>;
  try { params = contactExportJobSchema.parse(job.params); } catch {
    await db.job.update({ where: { id: jobId }, data: { status: 'FAILED', errorCode: 'EXPORT_PARAMS_INVALID', finishedAt: new Date() } });
    return;
  }
  const checkpoint = checkpointSchema.safeParse(job.checkpoint);
  const previous = params.format === 'csv' && checkpoint.success ? checkpoint.data : {};
  let processed = previous.processed ?? 0;
  let lastId = previous.lastId;
  let handle: FileHandle | undefined;
  let part: string | undefined;

  const where: Prisma.ContactWhereInput = {
    ...(params.consentStatus ? { consentStatus: params.consentStatus } : {}),
    ...(params.listId ? { lists: { some: { listId: params.listId } } } : {}),
    ...(params.tag ? { tags: { has: params.tag } } : {}),
  };

  try {
    if (signal.aborted) throw new ExportCancelled();
    const root = resolve(exportRoot);
    await mkdir(root, { recursive: true, mode: 0o700 });
    await chmod(root, 0o700);
    const path = resolve(root, `${jobId}.${params.format}`);
    if (!path.startsWith(root + sep)) throw new Error('EXPORT_PATH_INVALID');
    part = `${path}.part`;

    const total = await db.contact.count({ where });
    await db.job.update({ where: { id: jobId }, data: { totalItems: total, processed, progress: total ? Math.min(95, Math.floor((processed / total) * 100)) : 5 } });

    if (params.format === 'csv') {
      const partExists = await stat(part).then(() => true).catch(() => false);
      if (previous.lastId && previous.bytes !== undefined && partExists) {
        handle = await open(part, 'r+');
        await handle.truncate(previous.bytes);
      } else {
        await rm(part, { force: true });
        handle = await open(part, 'w', 0o600);
        await writeAll(handle, '\uFEFF' + contactCsv([], true));
        lastId = undefined; processed = 0;
      }
    }

    const collected: ContactExportRow[] = [];
    const effectiveBatch = Math.max(50, batchSize);
    for (;;) {
      if (signal.aborted) throw new ExportCancelled();
      const current = await db.job.findUnique({ where: { id: jobId }, select: { cancellationRequestedAt: true } });
      if (current?.cancellationRequestedAt) throw new ExportCancelled();
      const rows = await db.contact.findMany({
        where: { ...where, ...(lastId ? { id: { gt: lastId } } : {}) } as Prisma.ContactWhereInput,
        include: { identities: true },
        orderBy: { id: 'asc' },
        take: effectiveBatch,
      });
      if (!rows.length) break;
      lastId = rows[rows.length - 1]!.id;
      const keys = rows.flatMap(row => row.identities.map(identity => identity.key));
      const suppressed = new Set((await db.suppression.findMany({ where: { identityKey: { in: keys } }, select: { identityKey: true } })).map(row => row.identityKey));
      const output = rows.map(row => contactExportRow(cipher, row, row.identities.some(identity => suppressed.has(identity.key))));
      processed += output.length;
      if (params.format === 'csv') {
        await writeAll(handle!, contactCsv(output, false));
        const bytes = (await handle!.stat()).size;
        await db.job.update({ where: { id: jobId }, data: { processed, progress: total ? Math.min(99, Math.floor((processed / total) * 100)) : 99, errorCode: null, checkpoint: { lastId, bytes, processed } } });
      } else {
        collected.push(...output);
        await db.job.update({ where: { id: jobId }, data: { processed, progress: total ? Math.min(99, Math.floor((processed / total) * 100)) : 99, errorCode: null } });
      }
      if (rows.length < effectiveBatch) break;
    }

    if (params.format === 'xlsx') {
      await writeFile(part, contactWorkbook(collected), { mode: 0o600 });
    } else {
      await handle!.close();
      handle = undefined;
    }
    await chmod(part, 0o600);
    await rename(part, path);
    part = undefined;
    const bytes = (await stat(path)).size;
    await db.job.update({ where: { id: jobId }, data: { status: 'COMPLETED', progress: 100, processed, totalItems: total, finishedAt: new Date(), errorCode: null, checkpoint: { completed: true }, result: { format: params.format, filename: `contacts-${jobId.slice(0, 8)}.${params.format}`, bytes, rows: processed } } });
    await db.auditLog.create({ data: { action: 'contacts.export', resourceType: 'Job', resourceId: jobId, metadata: { format: params.format, count: processed } } });
  } catch (error) {
    const cancelled = error instanceof ExportCancelled;
    await db.job.update({ where: { id: jobId }, data: { status: cancelled ? 'CANCELLED' : 'FAILED', finishedAt: new Date(), errorCode: cancelled ? 'CANCELLED' : 'EXPORT_FAILED' } }).catch(() => undefined);
  } finally {
    await handle?.close().catch(() => undefined);
  }
}
