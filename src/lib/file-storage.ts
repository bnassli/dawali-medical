import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

/**
 * Private patient-file storage (ADR-033). Bytes never go into PostgreSQL and
 * are never served statically; callers reach them only through services that
 * check permissions. Write-once: an existing key is never overwritten.
 * Local directory now; an S3-compatible implementation can replace it behind
 * this interface without touching callers.
 */
export interface FileStorage {
  put(key: string, bytes: Uint8Array): Promise<void>;
  get(key: string): Promise<Uint8Array>;
}

const KEY_PATTERN = /^[a-z0-9][a-z0-9/_.-]{0,250}$/;

export function assertSafeKey(key: string): void {
  if (!KEY_PATTERN.test(key) || key.includes("..") || key.includes("//")) {
    throw new Error(`Unsafe storage key: ${key}`);
  }
}

export class LocalFileStorage implements FileStorage {
  constructor(private readonly root: string) {}

  private resolve(key: string): string {
    assertSafeKey(key);
    const root = path.resolve(this.root);
    const full = path.resolve(root, key);
    if (!full.startsWith(root + path.sep)) throw new Error(`Unsafe storage key: ${key}`);
    return full;
  }

  async put(key: string, bytes: Uint8Array): Promise<void> {
    const full = this.resolve(key);
    await mkdir(path.dirname(full), { recursive: true, mode: 0o700 });
    // "wx": fail if it exists — stored files are never replaced.
    await writeFile(full, bytes, { flag: "wx", mode: 0o600 });
  }

  async get(key: string): Promise<Uint8Array> {
    return new Uint8Array(await readFile(this.resolve(key)));
  }
}
