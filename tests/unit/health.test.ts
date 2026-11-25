import { expect, it } from 'vitest';
import { checkDependencies } from '../../packages/shared/src/health.js';

it('reports unavailable dependencies without leaking credentials or throwing', async () => {
  // Loopback port 1 is intentionally unreachable; no external network or Telegram.
  const state = await checkDependencies('postgresql://test:secret@127.0.0.1:1/test', 'redis://127.0.0.1:1');
  expect(state).toEqual({ postgres: false, redis: false });
  expect(JSON.stringify(state)).not.toContain('secret');
}, 7000);
