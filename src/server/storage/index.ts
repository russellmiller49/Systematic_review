// File storage abstraction. All binary objects (full-text PDFs, export payloads) go through
// this interface so the driver can be swapped without touching services.
//
// Drivers:
//   - LocalDiskStorage (MVP): files under `${STORAGE_DIR}/uploads/<key>`.
//   - S3 slot: an S3Storage implementing FileStorage would be selected here when
//     STORAGE_DRIVER=s3 (bucket/region/credentials via S3_BUCKET, S3_REGION, AWS_* env vars).
//     Same key scheme ('<projectId>/<random>.pdf'), keys map 1:1 to object keys.

import { promises as fs } from "node:fs";
import path from "node:path";

export interface FileStorage {
  put(key: string, data: Buffer): Promise<void>;
  get(key: string): Promise<Buffer>;
  delete(key: string): Promise<void>;
  exists(key: string): Promise<boolean>;
}

export class LocalDiskStorage implements FileStorage {
  private readonly root: string;

  constructor(rootDir: string) {
    this.root = path.resolve(rootDir);
  }

  // Path-traversal guard: the resolved path MUST stay strictly under the storage root.
  // Keys like '../outside', absolute paths, or 'a/../../b' are rejected.
  private resolve(key: string): string {
    const full = path.resolve(this.root, key);
    if (full === this.root || !full.startsWith(this.root + path.sep)) {
      throw new Error(`Invalid storage key: ${key}`);
    }
    return full;
  }

  async put(key: string, data: Buffer): Promise<void> {
    const full = this.resolve(key);
    await fs.mkdir(path.dirname(full), { recursive: true });
    await fs.writeFile(full, data);
  }

  async get(key: string): Promise<Buffer> {
    return fs.readFile(this.resolve(key));
  }

  async delete(key: string): Promise<void> {
    try {
      await fs.unlink(this.resolve(key));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
  }

  async exists(key: string): Promise<boolean> {
    try {
      await fs.access(this.resolve(key));
      return true;
    } catch {
      return false;
    }
  }
}

let singleton: FileStorage | undefined;

// Env-based driver selection (lazy so tests can point STORAGE_DIR at a temp dir before
// the first storage call). Only the local-disk driver exists in the MVP — see the S3
// slot documented at the top of this file.
export function getStorage(): FileStorage {
  if (!singleton) {
    const root = process.env.STORAGE_DIR ?? "./storage";
    singleton = new LocalDiskStorage(path.join(root, "uploads"));
  }
  return singleton;
}
