import { PrismaClient } from '../generated/client/client.js';
import { PrismaPg } from '@prisma/adapter-pg';
export function createDatabase(connectionString: string): PrismaClient {
  return new PrismaClient({ adapter: new PrismaPg({ connectionString, connectionTimeoutMillis: 2500, query_timeout: 2500 }) });
}
export { PrismaClient };
