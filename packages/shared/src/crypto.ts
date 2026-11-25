import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import * as argon2 from 'argon2';

export const hashToken = (token: string): string => createHash('sha256').update(token).digest('hex');
export const opaqueToken = (): string => randomBytes(32).toString('hex');
export const passwordOptions = { type: argon2.argon2id, memoryCost: 65536, timeCost: 3, parallelism: 1 } as const;
export const hashPassword = (password: string): Promise<string> => argon2.hash(password, passwordOptions);
export const verifyPassword = (hash: string, password: string): Promise<boolean> => argon2.verify(hash, password);
export function equalSecret(left: string, right: string): boolean {
  const a = Buffer.from(left); const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}
export const csrfFor = (token: string): string => createHmac('sha256', Buffer.from(token, 'hex')).update('csrf:v1').digest('hex');
export class FieldCipher {
  constructor(private readonly encryptionKey: string, private readonly identityKey: string) {}
  encrypt(value: string, context: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', Buffer.from(this.encryptionKey, 'hex'), iv);
    cipher.setAAD(Buffer.from(context));
    const ciphertext = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
    return ['v1', iv.toString('base64url'), cipher.getAuthTag().toString('base64url'), ciphertext.toString('base64url')].join('.');
  }
  decrypt(value: string, context: string): string {
    const [version, nonce, tag, ciphertext, extra] = value.split('.');
    if (version !== 'v1' || !nonce || !tag || !ciphertext || extra !== undefined) throw new Error('Invalid encrypted field');
    const decipher = createDecipheriv('aes-256-gcm', Buffer.from(this.encryptionKey, 'hex'), Buffer.from(nonce, 'base64url'));
    decipher.setAAD(Buffer.from(context)); decipher.setAuthTag(Buffer.from(tag, 'base64url'));
    return Buffer.concat([decipher.update(Buffer.from(ciphertext, 'base64url')), decipher.final()]).toString('utf8');
  }
  identity(value: string): string { return createHmac('sha256', Buffer.from(this.identityKey, 'hex')).update(value).digest('hex'); }
}
