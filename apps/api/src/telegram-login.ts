import { hashToken } from './crypto.js';
import type { ApiConfig } from './config.js';
import { problem } from './store.js';
import { loginBridgeToken, type LoginCommand, type LoginView } from '../../../packages/shared/src/telegram-login.js';
export async function forwardTelegramLogin(config: ApiConfig, accountId: string, actorId: string, sessionToken: string, command: LoginCommand): Promise<LoginView> {
  if (!config.WORKER_LOGIN_URL) problem(503, 'LOGIN_WORKER_UNAVAILABLE', 'Login worker is not configured');
  try {
    const response = await fetch(`${config.WORKER_LOGIN_URL}/owner-login`, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(22000), headers: { authorization: `Bearer ${loginBridgeToken(config.DATA_ENCRYPTION_KEY)}`, 'content-type': 'application/json' }, body: JSON.stringify({ accountId, actorId, sessionId: hashToken(sessionToken), command }) });
    const result = await response.json() as LoginView & { code?: string };
    if (!response.ok) problem([400, 403, 404, 409, 429, 503].includes(response.status) ? response.status : 503, result.code ?? 'LOGIN_WORKER_UNAVAILABLE', 'Telegram login request could not be completed');
    return result;
  } catch (error) {
    if (error instanceof Error && 'getStatus' in error) throw error;
    problem(503, 'LOGIN_WORKER_UNAVAILABLE', 'Login worker temporarily unavailable');
  }
}
