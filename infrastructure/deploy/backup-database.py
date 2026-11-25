#!/usr/bin/env python3
"""Host-side encrypted database backup. Run as root with cryptography installed.

The database password is never placed in arguments: pg_dump uses the PostgreSQL
container's local socket. This covers the DB, not live browser runtime profiles.
"""
from datetime import datetime, timezone
from pathlib import Path
import fcntl
import os
import secrets
import subprocess
import sys
import tempfile
from cryptography.hazmat.primitives.ciphers import Cipher, algorithms, modes

ROOT = Path(os.environ.get('SMART_ROOT', Path(__file__).resolve().parents[2]))
SHARED = ROOT / 'shared'
BACKUPS = SHARED / 'backups'
os.umask(0o077)
BACKUPS.mkdir(parents=True, exist_ok=True, mode=0o700)
lock = (BACKUPS / '.backup.lock').open('a')
try:
    fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
except BlockingIOError:
    print('A database backup is already running')
    sys.exit(0)
key_file = SHARED / 'backup.key'
if not key_file.exists():
    with key_file.open('xb') as handle:
        handle.write(secrets.token_bytes(32))
    key_file.chmod(0o600)
key = key_file.read_bytes()
if len(key) != 32:
    raise SystemExit('Invalid backup key')
stamp = datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ')
target = BACKUPS / ('database-' + stamp + '-' + secrets.token_hex(3) + '.stb')
partial = target.with_suffix('.partial')
command = [
    'docker', 'compose', '--project-directory', str(ROOT / 'current'),
    '-f', str(ROOT / 'current' / 'docker-compose.production.yml'),
    'exec', '-T', 'postgres', 'sh', '-c',
    'exec pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Fc',
]
process = None
try:
    nonce = secrets.token_bytes(12)
    encryptor = Cipher(algorithms.AES(key), modes.GCM(nonce)).encryptor()
    encryptor.authenticate_additional_data(b'smart-telegram-database-backup-v1')
    total = 0
    with tempfile.TemporaryFile() as errors, partial.open('xb') as output:
        output.write(b'STB1' + nonce + bytes(16))
        process = subprocess.Popen(command, stdout=subprocess.PIPE, stderr=errors)
        while True:
            chunk = process.stdout.read(1024 * 1024)
            if not chunk:
                break
            if total == 0 and not chunk.startswith(b'PGDMP'):
                raise RuntimeError('Unexpected dump format')
            total += len(chunk)
            output.write(encryptor.update(chunk))
        if process.wait(timeout=600) != 0 or total == 0:
            raise RuntimeError('Database dump failed')
        output.write(encryptor.finalize())
        output.seek(16)
        output.write(encryptor.tag)
        output.flush()
        os.fsync(output.fileno())
    os.replace(partial, target)
    cutoff = datetime.now(timezone.utc).timestamp() - 14 * 86400
    for old in BACKUPS.glob('database-*.stb'):
        if old.parent.resolve() == BACKUPS.resolve() and old.is_file() and old.stat().st_mtime < cutoff:
            old.unlink()
    print('Encrypted database backup completed: ' + target.name + ' (' + str(total) + ' dump bytes)')
except Exception:
    if process is not None and process.poll() is None:
        process.kill()
        process.wait()
    if partial.exists():
        partial.unlink()
    print('Database backup failed; no incomplete backup was committed', file=sys.stderr)
    sys.exit(1)
