import type { ApiConfig } from './config.js';
import { hashPassword, opaqueToken, verifyPassword } from './crypto.js';
import { PlatformStore, problem } from './store.js';
export class AuthService {
  private activeHashes = 0;
  private constructor(private readonly store: PlatformStore, private readonly config: ApiConfig, private readonly dummyHash: string) {}
  static async create(store: PlatformStore, config: ApiConfig) { return new AuthService(store, config, await hashPassword(opaqueToken())); }
  async login(email: string, password: string) {
    if (this.activeHashes >= 4) problem(429, 'RATE_LIMITED', 'Login capacity reached');
    this.activeHashes++;
    try {
    const user = await this.store.findUser(email);
    const valid = await verifyPassword(user?.passwordHash ?? this.dummyHash, password);
    if (!user || !valid) problem(401, 'INVALID_CREDENTIALS', 'Email or password is incorrect');
    const token = opaqueToken();
    const expiresAt = new Date(Date.now() + this.config.SESSION_TTL_SECONDS * 1000);
    const principal = { id: user.id, email: user.email, role: user.role };
    await this.store.createSession(principal, token, expiresAt);
    return { user: principal, token, expiresAt };
    } finally { this.activeHashes--; }
  }
}
