import { randomBytes, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import readXlsxFile from 'read-excel-file/node';
import { createDatabase } from '../../packages/database/src/index.js';
import { FieldCipher } from '../../packages/shared/src/crypto.js';
import { ContactsService } from '../../apps/api/src/contacts.js';
import { CampaignsService } from '../../apps/api/src/campaigns.js';
import { OperationsService } from '../../apps/api/src/operations.js';
import { processContactsExport } from '../../apps/worker/src/contacts-export.js';

const url = process.env.DRILL_DATABASE_URL;
if (!url) throw new Error('DRILL_DATABASE_URL required');
const exportRoot = process.env.DRILL_EXPORT_ROOT ?? '/tmp/smart-telegram-drill-exports';
const db = createDatabase(url);
const cipher = new FieldCipher(randomBytes(32).toString('hex'), randomBytes(32).toString('hex'));
const contacts = new ContactsService(db, cipher, { batchSize: 25, exportRoot, importMaxRows: 500 });
const campaigns = new CampaignsService(db, cipher, 5000);
const operations = new OperationsService(db, cipher);
const admin = await db.adminUser.create({ data: { email: `drill-${randomUUID()}@example.test`, passwordHash: 'x', role: 'ADMIN' } });
const actor = { id: admin.id, email: admin.email, role: 'ADMIN' as const };

try {
  const list = await contacts.createList(actor, { name: `Drill list ${randomUUID()}` });
  const contact = await contacts.create(actor, { displayName: 'Drill Contact', username: `drill_${randomUUID().slice(0, 8)}`, phone: '+15550000002', tags: ['drill'], listIds: [list.id], consentStatus: 'UNKNOWN', source: 'MANUAL' });
  const accountId = randomUUID();
  await db.telegramAccount.create({ data: { id: accountId, displayName: 'Drill account', encryptedPhone: cipher.encrypt('+15550000002', `account:${accountId}:phone`), identityKey: cipher.identity(`phone:+15550000002`), status: 'CONNECTED' } });
  const templateId = randomUUID();
  await db.messageTemplate.create({ data: { id: templateId, name: `drill-${templateId}`, version: 1, content: cipher.encrypt('Hello {{displayName}}', `template:${templateId}`) } });
  const campaignId = randomUUID();
  await db.campaign.create({ data: { id: campaignId, name: 'Drill campaign', creationKey: randomUUID(), requestHash: 'drill', messageTemplateId: templateId, contactListId: list.id, accountId, status: 'DRAFT' } });

  let missing = '';
  try { await campaigns.start(actor, campaignId); } catch (error) { missing = (error as { response?: { code?: string } }).response?.code ?? String(error); }
  if (missing !== 'AUTHORIZATION_MISSING') throw new Error(`Expected AUTHORIZATION_MISSING, got ${missing}`);
  const before = await campaigns.validate(campaignId);
  if (before.eligible !== 0) throw new Error(`Unauthorized audience should be 0, got ${before.eligible}`);

  const authorization = await operations.authorizeOutreach(actor, 'drill-evidence/2026-11');
  if (!authorization.id) throw new Error('Authorization not created');
  const after = await campaigns.validate(campaignId);
  if (after.eligible !== 1 || !after.authorizationActive) throw new Error(`Authorized audience should be 1, got ${JSON.stringify(after)}`);

  const started = await campaigns.start(actor, campaignId);
  if (started.eligible !== 1) throw new Error(`Expected 1 eligible, got ${started.eligible}`);
  const jobs = await db.job.count({ where: { campaignId } });
  if (jobs !== 1) throw new Error(`Expected 1 job, got ${jobs}`);

  const csvJob = await contacts.createExportJob(actor, 'csv', {});
  await processContactsExport(db, cipher, csvJob.jobId, 'drill-worker', new AbortController().signal, exportRoot, 25);
  const csvState = await db.job.findUniqueOrThrow({ where: { id: csvJob.jobId } });
  if (csvState.status !== 'COMPLETED') throw new Error(`CSV export status ${csvState.status} ${csvState.errorCode}`);
  const csv = await readFile(`${exportRoot}/${csvJob.jobId}.csv`, 'utf8');
  if (!csv.includes('Drill Contact') || csv.includes('consentStatus')) throw new Error('CSV content mismatch');

  const xlsxJob = await contacts.createExportJob(actor, 'xlsx', {});
  await processContactsExport(db, cipher, xlsxJob.jobId, 'drill-worker', new AbortController().signal, exportRoot, 25);
  const xlsxState = await db.job.findUniqueOrThrow({ where: { id: xlsxJob.jobId } });
  if (xlsxState.status !== 'COMPLETED') throw new Error(`XLSX export status ${xlsxState.status} ${xlsxState.errorCode}`);
  const sheets = await readXlsxFile(`${exportRoot}/${xlsxJob.jobId}.xlsx`) as unknown as { data: unknown[][] }[];
  const header = sheets[0]!.data[0]!;
  if (header.includes('consentStatus') || !header.includes('displayName')) throw new Error('XLSX header mismatch');
  if (sheets[0]!.data[1]![0] !== 'Drill Contact') throw new Error('XLSX row mismatch');

  const retryJob = await contacts.createExportJob(actor, 'csv', {});
  await processContactsExport(db, cipher, retryJob.jobId, 'drill-worker', new AbortController().signal, '/proc/smart-forbidden', 25);
  const failed = await db.job.findUniqueOrThrow({ where: { id: retryJob.jobId } });
  if (failed.status !== 'FAILED' || failed.errorCode !== 'EXPORT_FAILED') throw new Error(`Expected failed export, got ${failed.status}/${failed.errorCode}`);
  await contacts.resumeExportJob(actor, retryJob.jobId);
  await processContactsExport(db, cipher, retryJob.jobId, 'drill-worker', new AbortController().signal, exportRoot, 25);
  const retried = await db.job.findUniqueOrThrow({ where: { id: retryJob.jobId } });
  if (retried.status !== 'COMPLETED') throw new Error(`Expected resumed export COMPLETED, got ${retried.status}/${retried.errorCode}`);

  console.log(JSON.stringify({ ok: true, campaignJobs: jobs, csvRows: csvState.processed, xlsxBytes: (xlsxState.result as { bytes?: number } | null)?.bytes, resumedExport: retried.id, authorization: authorization.id, contact: contact.id }, null, 2));
} finally {
  await db.$disconnect();
}
