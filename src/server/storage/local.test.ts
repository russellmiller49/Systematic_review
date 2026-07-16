import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { LocalDiskStorage } from "./index";

describe("LocalDiskStorage", () => {
  let storage: LocalDiskStorage;
  let root: string;

  beforeAll(() => {
    root = mkdtempSync(path.join(os.tmpdir(), "srb-storage-test-"));
    storage = new LocalDiskStorage(root);
  });

  it("round-trips put/get/exists/delete", async () => {
    const key = "proj1/abc123.pdf";
    const data = Buffer.from("%PDF-1.4\nhello");
    await expect(storage.exists(key)).resolves.toBe(false);
    await storage.put(key, data);
    await expect(storage.exists(key)).resolves.toBe(true);
    await expect(storage.get(key)).resolves.toEqual(data);
    await storage.delete(key);
    await expect(storage.exists(key)).resolves.toBe(false);
  });

  it("delete is a no-op for missing keys", async () => {
    await expect(storage.delete("proj1/never-existed.pdf")).resolves.toBeUndefined();
  });

  it("rejects path-traversal keys — resolved path must stay under the root", async () => {
    const evil = [
      "../outside.pdf",
      "..",
      "a/../../outside.pdf",
      "proj1/../../outside.pdf",
      "/etc/passwd",
      path.join(os.tmpdir(), "absolute.pdf"),
    ];
    for (const key of evil) {
      await expect(storage.put(key, Buffer.from("x")), key).rejects.toThrow(/Invalid storage key/);
      await expect(storage.get(key), key).rejects.toThrow(/Invalid storage key/);
      await expect(storage.delete(key), key).rejects.toThrow(/Invalid storage key/);
    }
  });

  it("rejects the root itself as a key", async () => {
    await expect(storage.get(".")).rejects.toThrow(/Invalid storage key/);
    await expect(storage.get("")).rejects.toThrow(/Invalid storage key/);
  });

  it("allows nested keys that stay under the root", async () => {
    const key = "proj2/sub/deep.pdf";
    await storage.put(key, Buffer.from("data"));
    await expect(storage.get(key)).resolves.toEqual(Buffer.from("data"));
  });
});
