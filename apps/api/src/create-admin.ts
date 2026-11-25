import { createDatabase } from '../../../packages/database/src/index.js';
import { createAdminSchema } from './contracts.js';
import { hashPassword } from './crypto.js';
// Credentials arrive via environment, never command-line arguments or logs.
const input = createAdminSchema.safeParse({ email: process.env.ADMIN_EMAIL, password: process.env.ADMIN_PASSWORD });
if (!input.success || !process.env.DATABASE_URL) { console.error('Set DATABASE_URL, ADMIN_EMAIL and ADMIN_PASSWORD (14–256 characters)'); process.exit(1); }
const db = createDatabase(process.env.DATABASE_URL);
try {
  const passwordHash = await hashPassword(input.data.password);
  await db.$transaction(async tx => {
    const user = await tx.adminUser.create({ data: { email: input.data.email, passwordHash, role: 'ADMIN' } });
    await tx.auditLog.create({ data: { actorId: user.id, action: 'admin.provision', resourceType: 'AdminUser', resourceId: user.id } });
  });
  console.log('Administrator created; existing users are never overwritten');
} catch { console.error('Administrator provisioning failed; check database connectivity and email uniqueness'); process.exitCode = 1; }
finally { await db.$disconnect(); }
