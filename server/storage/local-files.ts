import type { Dirent } from 'node:fs';
import { mkdir, rename, readdir, stat, unlink } from 'node:fs/promises';
import { dirname, join, relative, sep } from 'node:path';
import { randomUUID } from 'node:crypto';

const SAFE_KEY = /^[A-Za-z0-9._/-]{1,512}$/;

function assertKey(key: string) {
  const clean = String(key || '');
  if (
    !SAFE_KEY.test(clean) ||
    clean.startsWith('/') ||
    clean.includes('\\') ||
    clean.split('/').some((part) => !part || part === '.' || part === '..')
  ) {
    throw new Error('invalid object key');
  }
  return clean;
}

/**
 * Local replacement for the R2 FILES binding. Objects remain AES-GCM ciphertext;
 * only the storage location changes, so object_key and attachment AAD stay valid.
 */
export class LocalFileStore {
  constructor(private root: string) {
    void mkdir(this.root, { recursive: true }).catch(() => {});
  }

  private path(key: string) {
    return `${join(this.root, assertKey(key))}.bin`;
  }

  async put(key: string, data: ArrayBuffer | Uint8Array | Blob | ReadableStream) {
    const target = this.path(key);
    await mkdir(dirname(target), { recursive: true });
    const tmp = `${target}.${randomUUID()}.tmp`;
    await Bun.write(tmp, data as any);
    await rename(tmp, target);
    return { key };
  }

  get(key: string) {
    return Bun.file(this.path(key));
  }

  async exists(key: string) {
    return this.get(key).exists();
  }

  async size(key: string) {
    const file = this.get(key);
    return (await file.exists()) ? file.size : 0;
  }

  async delete(key: string) {
    try {
      await unlink(this.path(key));
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
      throw error;
    }
  }

  /** Admin storage scan compatibility; walks the shard tree in key order. */
  async list({ limit = 1000, cursor = '' } = {}) {
    const keys: string[] = [];
    async function walk(dir: string) {
      let entries: Dirent[];
      try {
        entries = await readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) await walk(full);
        else if (entry.name.endsWith('.bin') && !entry.name.endsWith('.tmp')) keys.push(full);
      }
    }
    await walk(this.root);
    keys.sort();
    const mapped = keys
      .map((full) => {
        const rel = relative(this.root, full).split(sep).join('/');
        return { rel, key: rel.slice(0, -4), full };
      })
      .filter((item) => !cursor || item.key > cursor);
    const page = mapped.slice(0, Math.max(1, Number(limit) || 1000));
    const objects = await Promise.all(
      page.map(async (item) => {
        const info = await stat(item.full);
        return {
          key: item.key,
          size: info.size,
          uploaded: info.mtime,
          customMetadata: {} as Record<string, string>
        };
      })
    );
    return {
      objects,
      truncated: mapped.length > page.length,
      cursor: mapped.length > page.length ? page.at(-1)?.key ?? null : null
    };
  }

  async cleanupTemp(maxAgeMs = 60 * 60 * 1000) {
    const cutoff = Date.now() - maxAgeMs;
    async function walk(dir: string) {
      let entries: Dirent[];
      try {
        entries = await readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) await walk(full);
        else if (entry.name.endsWith('.tmp')) {
          try {
            const info = await stat(full);
            if (info.mtimeMs < cutoff) await unlink(full);
          } catch {
            // best effort
          }
        }
      }
    }
    await walk(this.root);
  }
}
