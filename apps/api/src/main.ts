import { Redis } from 'ioredis';
import type { Server } from 'node:http';
import { createDatabase } from '../../../packages/database/src/index.js';
import { apiConfigSchema } from './config.js';
import { FieldCipher } from './crypto.js';
import { PlatformStore } from './store.js';
import { AuthService } from './auth.service.js';
import { RedisRateLimiter } from './rate-limit.js';
import { createApp } from './app.js';
import { ContactsService } from './contacts.js';
import { CampaignsService } from './campaigns.js';
import { OperationsService } from './operations.js';
import { attachRealtime } from './realtime.js';
import { shutdownTelemetry } from './telemetry.js';
import { AccountSourcesService } from './account-sources.js';
const parsed = apiConfigSchema.safeParse(process.env);
if (!parsed.success) { console.error('Invalid API configuration; check required settings in .env.example'); process.exit(1); }
const config = parsed.data;
const db = createDatabase(config.DATABASE_URL);
const redis = new Redis(config.REDIS_URL, { lazyConnect: true, maxRetriesPerRequest: 0, enableOfflineQueue: false, connectTimeout: 2000, commandTimeout: 2000, retryStrategy: times => Math.min(times * 250, 3000) });
redis.on('error', () => undefined);
// A disconnected limiter fails closed for business routes, while health stays available.
void redis.connect().catch(() => undefined);
const store = new PlatformStore(db, new FieldCipher(config.DATA_ENCRYPTION_KEY, config.IDENTITY_HMAC_KEY));
const auth = await AuthService.create(store, config);
const cipher = new FieldCipher(config.DATA_ENCRYPTION_KEY, config.IDENTITY_HMAC_KEY);
const app = await createApp({ config, store, auth, limiter: new RedisRateLimiter(redis), contacts: new ContactsService(db, cipher, { batchSize: config.EXPORT_BATCH_SIZE, exportRoot: config.EXPORT_ROOT, importMaxRows: config.IMPORT_MAX_ROWS }), campaigns: new CampaignsService(db, cipher, config.QUEUE_MAX_PENDING), operations: new OperationsService(db, cipher), sources: new AccountSourcesService(db, cipher, config.QUEUE_MAX_PENDING) });
app.enableShutdownHooks();
const shutdown = async () => { redis.disconnect(); await db.$disconnect(); };
const server: Server = app.getHttpServer();
const closeRealtime = attachRealtime(server, store, config);
server.on('close', () => void shutdown());
// Nest owns the server; explicit process hooks release external clients as well.
for (const event of ['SIGINT', 'SIGTERM'] as const) process.once(event, () => { void closeRealtime(); void shutdownTelemetry(); void shutdown(); });
await app.listen(config.API_PORT, '0.0.0.0');
