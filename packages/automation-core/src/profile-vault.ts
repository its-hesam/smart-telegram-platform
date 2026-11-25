import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { chmod, mkdir, open, readFile, rename, rm, stat, statfs, lstat } from 'node:fs/promises';
import { resolve, join, dirname, sep } from 'node:path';
import { pipeline } from 'node:stream/promises';
import * as tar from 'tar';

const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
export class ProfileVault {
  constructor(private readonly archiveRoot: string, private readonly runtimeRoot: string, private readonly key: Buffer, private readonly requireTmpfs = true) {
    if (key.length !== 32) throw new Error('Profile encryption requires 32 bytes');
    if (resolve(archiveRoot) === resolve(runtimeRoot)) throw new Error('Archive and runtime must differ');
  }
  private path(root: string, id: string) {
    if (!uuid.test(id)) throw new Error('Invalid account ID');
    const base = resolve(root); const target = resolve(base, id);
    if (!target.startsWith(base + sep)) throw new Error('Unsafe profile path');
    return target;
  }
  async prepare(id: string): Promise<string> {
    const runtime = this.path(this.runtimeRoot, id);
    await mkdir(this.runtimeRoot, { recursive: true, mode: 0o700 });
    await mkdir(this.archiveRoot, { recursive: true, mode: 0o700 });
    if ((await lstat(this.runtimeRoot)).isSymbolicLink() || (await lstat(this.archiveRoot)).isSymbolicLink()) throw new Error('Profile roots cannot be symbolic links');
    await chmod(this.runtimeRoot, 0o700); await chmod(this.archiveRoot, 0o700);
    if (this.requireTmpfs && (process.platform !== 'linux' || Number((await statfs(this.runtimeRoot)).type) !== 0x01021994)) throw new Error('Production profile runtime requires Linux tmpfs');
    if (this.requireTmpfs && (await readFile('/proc/swaps', 'utf8')).trim().split('\n').length > 1) throw new Error('Disable host swap before using production profile tmpfs');
    // Atomic mkdir refuses stale runtime profiles after a crash. No automatic takeover.
    await mkdir(runtime, { mode: 0o700 });
    const archive = `${this.path(this.archiveRoot, id)}.enc`;
    const restoredTar = join(runtime, '.restore.tar');
    try {
      try { await stat(archive); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return runtime; throw error; }
      const source = await open(archive, 'r'); const header = Buffer.alloc(32);
      try { const read = await source.read(header, 0, 32, 0); if (read.bytesRead !== 32 || header.subarray(0, 4).toString() !== 'STP1') throw new Error('Invalid profile archive'); } finally { await source.close(); }
      const decipher = createDecipheriv('aes-256-gcm', this.key, header.subarray(4, 16));
      decipher.setAAD(Buffer.from(`profile:v1:${id}`)); decipher.setAuthTag(header.subarray(16, 32));
      await pipeline(createReadStream(archive, { start: 32 }), decipher, createWriteStream(restoredTar, { flags: 'wx', mode: 0o600 }));
      // Extraction starts only after GCM authentication succeeds.
      await tar.x({ file: restoredTar, cwd: runtime, strict: true, preservePaths: false, filter: (_path, entry) => 'type' in entry && ['File', 'Directory'].includes(entry.type) });
      await rm(restoredTar); return runtime;
    } catch (error) {
      await this.removeRuntime(runtime); throw error;
    }
  }
  async seal(id: string, runtime: string): Promise<void> {
    if (resolve(runtime) !== this.path(this.runtimeRoot, id)) throw new Error('Unexpected runtime path');
    const archive = `${this.path(this.archiveRoot, id)}.enc`;
    const temporary = `${archive}.${randomBytes(8).toString('hex')}.tmp`;
    const iv = randomBytes(12); const header = Buffer.alloc(32); header.write('STP1'); iv.copy(header, 4);
    const output = await open(temporary, 'wx', 0o600); await output.write(header); await output.close();
    try {
      const cipher = createCipheriv('aes-256-gcm', this.key, iv); cipher.setAAD(Buffer.from(`profile:v1:${id}`));
      await pipeline(tar.c({ cwd: runtime, portable: true, filter: (path, entry) => !path.includes('Singleton') && !path.includes('.restore.tar') && ('isSymbolicLink' in entry ? !entry.isSymbolicLink() : ['File', 'Directory'].includes(entry.type)) }, ['.']), cipher, createWriteStream(temporary, { flags: 'r+', start: 32 }));
      const file = await open(temporary, 'r+');
      try { await file.write(cipher.getAuthTag(), 0, 16, 16); await file.sync(); } finally { await file.close(); }
      await rename(temporary, archive);
      await this.removeRuntime(runtime);
    } catch (error) { await rm(temporary, { force: true }); throw error; }
  }
  private async removeRuntime(runtime: string) {
    const base = resolve(this.runtimeRoot);
    if (dirname(resolve(runtime)) !== base || !uuid.test(runtime.slice(base.length + 1))) throw new Error('Unsafe runtime removal');
    await rm(runtime, { recursive: true, force: true });
  }
}
