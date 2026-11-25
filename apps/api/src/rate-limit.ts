import { Redis } from 'ioredis';
export interface RateLimiter { consume(key: string, limit: number, windowSeconds: number): Promise<boolean>; }
const script = `local n = redis.call('INCR', KEYS[1]); if n == 1 then redis.call('EXPIRE', KEYS[1], ARGV[1]); end; return n`;
export class RedisRateLimiter implements RateLimiter {
  constructor(private readonly redis: Redis) {}
  async consume(key: string, limit: number, windowSeconds: number): Promise<boolean> {
    return Number(await this.redis.eval(script, 1, `api:rate:${key}`, windowSeconds)) <= limit;
  }
}
