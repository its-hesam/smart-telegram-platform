// Run only in the migration image with owner DATABASE_URL and temporary APP_DATABASE_PASSWORD.
import pg from 'pg';
import { randomBytes, pbkdf2Sync, createHmac, createHash } from 'node:crypto';
const role = process.env.APP_DATABASE_USER ?? 'smart_app';
const password = process.env.APP_DATABASE_PASSWORD;
if (!/^[a-z_][a-z0-9_]{0,31}$/.test(role) || !password || !/^[A-Za-z0-9_-]{24,128}$/.test(password) || !process.env.DATABASE_URL) throw new Error('Provide a valid application role and independent URL-safe database password');
// Hash the database password before DDL so plaintext never appears in a statement/log.
const salt = randomBytes(16); const iterations = 4096;
const salted = pbkdf2Sync(password, salt, iterations, 32, 'sha256');
const clientKey = createHmac('sha256', salted).update('Client Key').digest();
const storedKey = createHash('sha256').update(clientKey).digest('base64');
const serverKey = createHmac('sha256', salted).update('Server Key').digest('base64');
const verifier = `SCRAM-SHA-256$${iterations}:${salt.toString('base64')}$${storedKey}:${serverKey}`;
const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
try {
  await client.connect(); await client.query('BEGIN');
  if (!(await client.query('SELECT 1 FROM pg_roles WHERE rolname=$1', [role])).rowCount) await client.query(`CREATE ROLE "${role}" LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION`);
  await client.query(`ALTER ROLE "${role}" PASSWORD '${verifier}'`);
  const database = (await client.query('SELECT current_database() AS name')).rows[0].name;
  const sql = (await client.query('SELECT format(\'GRANT CONNECT ON DATABASE %I TO %I\', $1::text, $2::text) AS statement', [database, role])).rows[0].statement;
  await client.query(sql);
  await client.query(`GRANT USAGE ON SCHEMA public TO "${role}"`);
  await client.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO "${role}"`);
  await client.query(`ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO "${role}"`);
  await client.query(`REVOKE UPDATE, DELETE ON "AuditLog" FROM "${role}"`);
  await client.query(`REVOKE ALL ON "_prisma_migrations" FROM "${role}"`);
  await client.query('COMMIT');
  console.log('Application role provisioned; audit modification/deletion and migration-ledger access denied');
} catch { await client.query('ROLLBACK').catch(() => undefined); console.error('Application role provisioning failed; inspect migration owner permissions'); process.exitCode = 1; }
finally { await client.end(); }
