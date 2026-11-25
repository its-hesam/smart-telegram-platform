import 'dotenv/config';
import { spawn } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import pg from 'pg';
import { createDatabase } from '../../packages/database/src/index.js';
import { FieldCipher } from '../../packages/shared/src/crypto.js';
const source = new URL(process.env.DATABASE_URL ?? '');
if (!/_test$/.test(source.pathname)) throw new Error('Restore drill requires a dedicated *_test source database');
const targetName = `restore_${randomUUID().replaceAll('-', '')}_test`;
const file = join(tmpdir(), `smart-restore-${randomUUID()}.dump`);
const target = new URL(source); target.pathname = `/${targetName}`;
const adminUrl = new URL(source); adminUrl.pathname = '/postgres';
const admin = new pg.Client({ connectionString: adminUrl.toString() });
const db = createDatabase(source.toString()); const restored = createDatabase(target.toString());
const cipher = new FieldCipher(randomBytes(32).toString('hex'), randomBytes(32).toString('hex')); const key = `restore-fixture-${randomUUID()}`;
const common = ['--host', source.hostname, '--port', source.port || '5432', '--username', decodeURIComponent(source.username)];
const run = (command: string, args: string[]) => new Promise<void>((resolve, reject) => { const child = spawn(command, args, { env: { ...process.env, PGPASSWORD: decodeURIComponent(source.password) }, windowsHide: true, stdio: ['ignore', 'ignore', 'ignore'] }); child.once('error', reject); child.once('exit', code => code === 0 ? resolve() : reject(new Error('PostgreSQL backup/restore tool failed'))); });
let created = false;
try {
  await admin.connect();
  await db.systemSetting.create({ data: { key, value: cipher.encrypt('authorized-recovery-fixture', key) } });
  await run(process.env.PG_DUMP ?? 'pg_dump', [...common, '--dbname', source.pathname.slice(1), '--format=custom', '--file', file]);
  // Identifier is generated locally from UUID hex and constrained before destructive cleanup.
  if (!/^restore_[a-f0-9]{32}_test$/.test(targetName)) throw new Error('Invalid test database identifier');
  await admin.query(`CREATE DATABASE "${targetName}" TEMPLATE template0 ENCODING 'UTF8'`); created = true;
  await run(process.env.PG_RESTORE ?? 'pg_restore', [...common, '--dbname', targetName, '--no-owner', '--exit-on-error', file]);
  const row = await restored.systemSetting.findUniqueOrThrow({ where: { key } });
  if (typeof row.value !== 'string' || cipher.decrypt(row.value, key) !== 'authorized-recovery-fixture') throw new Error('Restored ciphertext verification failed');
  console.log(JSON.stringify({ restoreDrill: 'passed', database: 'temporary PostgreSQL', encryptedFixtureVerified: true, telegramDataUsed: false }));
} finally {
  await restored.$disconnect(); await db.systemSetting.deleteMany({ where: { key } }).catch(() => undefined); await db.$disconnect();
  if (created && /^restore_[a-f0-9]{32}_test$/.test(targetName)) await admin.query(`DROP DATABASE "${targetName}"`);
  await admin.end(); await unlink(file).catch(() => undefined);
}
