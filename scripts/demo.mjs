import EmbeddedPostgres from 'embedded-postgres';
import { spawn } from 'node:child_process';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createServer } from 'node:net';
import { createServer as httpServer } from 'node:http';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
const root = dirname(dirname(fileURLToPath(import.meta.url)));
const directory = join(root, '.demo'); await mkdir(directory, { recursive: true, mode: 0o700 });
const configFile = join(directory, 'config.json');
const config = existsSync(configFile) ? JSON.parse(await readFile(configFile, 'utf8')) : { databasePassword: randomBytes(32).toString('hex'), encryptionKey: randomBytes(32).toString('hex'), identityKey: randomBytes(32).toString('hex'), controlToken: randomBytes(32).toString('hex') };
await writeFile(configFile, JSON.stringify(config), { mode: 0o600 });
for (const port of [3000, 3001, 3002, 55440]) await new Promise((resolve, reject) => { const server = createServer(); server.once('error', () => reject(new Error(`Port ${port} is occupied; stop the previous demo before restarting`))); server.listen(port, '127.0.0.1', () => server.close(resolve)); });
const postgres = new EmbeddedPostgres({ databaseDir: join(directory, 'postgres'), user: 'smart_demo', password: config.databasePassword, port: 55440, persistent: true, authMethod: 'scram-sha-256', autoRehydrateSymlinks: true, initdbFlags: ['--encoding=UTF8'], onLog: () => undefined, onError: () => undefined });
const environment = { ...process.env, NODE_ENV: 'development', LOCAL_DEMO: 'true', DATABASE_URL: `postgresql://smart_demo:${config.databasePassword}@127.0.0.1:55440/smart_demo?schema=public`, REDIS_URL: 'redis://127.0.0.1:6379', API_PORT: '3001', APP_ORIGIN: 'http://localhost:3000', DATA_ENCRYPTION_KEY: config.encryptionKey, IDENTITY_HMAC_KEY: config.identityKey, LOG_LEVEL: 'warn', API_INTERNAL_URL: 'http://127.0.0.1:3001', NEXT_PUBLIC_DEMO: 'true', NEXT_PUBLIC_WS_URL: 'ws://localhost:3001/events', NEXT_TELEMETRY_DISABLED: '1', DEMO_PREVIEW: 'true' };
const children = [];
const start = args => { const child = spawn(process.execPath, args, { cwd: root, env: environment, stdio: 'inherit', windowsHide: true }); children.push(child); return child; };
const run = args => new Promise((resolve, reject) => { const child = start(args); child.once('error', reject); child.once('exit', code => code === 0 ? resolve() : reject(new Error(`Demo setup command failed (${code})`))); });
let control; let stopping = false;
async function stop() { if (stopping) return; stopping = true; if (control) control.close(); for (const child of children) if (child.exitCode === null) child.kill(); await postgres.stop().catch(() => undefined); await writeFile(join(directory, 'status.json'), JSON.stringify({ running: false })); }
try {
  console.log('Preparing isolated local demo database…');
  if (!existsSync(join(directory, 'postgres', 'PG_VERSION'))) await postgres.initialise();
  await postgres.start();
  const client = postgres.getPgClient('postgres'); await client.connect();
  const exists = await client.query('SELECT 1 FROM pg_database WHERE datname=$1', ['smart_demo']);
  if (!exists.rowCount) await client.query("CREATE DATABASE smart_demo WITH ENCODING 'UTF8' TEMPLATE template0");
  await client.end();
  await run(['node_modules/prisma/build/index.js', 'generate', '--config', 'packages/database/prisma.config.ts']);
  await run(['node_modules/prisma/build/index.js', 'migrate', 'deploy', '--config', 'packages/database/prisma.config.ts']);
  const api = start(['--import', 'tsx', 'scripts/demo-api.ts']);
  for (let i = 0; i < 120; i++) { if (api.exitCode !== null) throw new Error('Demo API exited'); try { if ((await fetch('http://127.0.0.1:3001/health/live')).ok) break; } catch {} if (i === 119) throw new Error('Demo API timed out'); await delay(500); }
  const web = start(['node_modules/next/dist/bin/next', 'dev', 'apps/web', '--hostname', '127.0.0.1', '--port', '3000']);
  for (let i = 0; i < 120; i++) { if (web.exitCode !== null) throw new Error('Demo web exited'); try { if ((await fetch('http://127.0.0.1:3000')).ok) break; } catch {} if (i === 119) throw new Error('Demo web timed out'); await delay(500); }
  control = httpServer((req, res) => {
    const supplied = Buffer.from(String(req.headers['x-demo-control'] ?? '')); const expected = Buffer.from(config.controlToken);
    if (req.method !== 'POST' || req.url !== '/stop' || supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) { res.writeHead(403); res.end(); return; }
    res.end('Demo stopping'); void stop().then(() => process.exit(0));
  });
  await new Promise(resolve => control.listen(3002, '127.0.0.1', resolve));
  await writeFile(join(directory, 'status.json'), JSON.stringify({ running: true, pid: process.pid, apiPid: api.pid, webPid: web.pid, url: 'http://localhost:3000', databasePort: 55440 }));
  console.log('DEMO READY: http://localhost:3000 — demo@smart.local / DemoPreview!2026 — no Telegram worker is running');
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { void stop().then(() => process.exit(0)); });
  api.once('exit', () => { if (!stopping) void stop().then(() => process.exit(1)); });
  web.once('exit', () => { if (!stopping) void stop().then(() => process.exit(1)); });
} catch (error) { console.error(error instanceof Error ? error.message : 'Demo startup failed'); await stop(); process.exitCode = 1; }
