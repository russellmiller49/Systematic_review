/** Default is read-only dry run. Credentials are supplied via DATABASE_URL, never arguments. */
import { open, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { PrismaClient } from "@prisma/client";
const prisma = new PrismaClient({ log: [] });
(globalThis as unknown as { prisma: PrismaClient }).prisma = prisma;
import type { IncludeTransferPlan } from "../src/server/services/screening/include-transfer";

async function main() {
  // Install a quiet client before service imports: Prisma error payloads may contain private data.
  const {
    canonical,
    transferDigest,
    validateManifest,
    dryRunIncludeTransfer,
    applyIncludeTransfer,
    rollbackIncludeTransfer,
  } = await import("../src/server/services/screening/include-transfer");

  async function durableWrite(path: string, value: unknown) {
    const file = await open(path, "wx", 0o600);
    try {
      await file.writeFile(canonical(value) + "\n");
      await file.sync();
    } finally {
      await file.close();
    }
    const directory = await open(dirname(resolve(path)), "r");
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
    const actual = JSON.parse(await readFile(path, "utf8"));
    if (transferDigest(actual) !== transferDigest(value))
      throw new Error("Backup read-back failed");
    return { location: resolve(path), sha256: transferDigest(actual) };
  }
  const args = process.argv.slice(2);
  const allowed = new Set([
    "--manifest",
    "--actor",
    "--approved-manifest-sha256",
    "--plan",
    "--backup",
    "--apply",
    "--rollback",
    "--dry-run",
  ]);
  if (
    args.some((a, i) => a.startsWith("--") && !allowed.has(a)) ||
    ["--apply", "--rollback", "--dry-run"].filter((x) => args.includes(x))
      .length > 1
  )
    throw new Error("Unknown or contradictory arguments");
  const get = (key: string) => {
    const n = args.indexOf(key);
    const value = n < 0 ? undefined : args[n + 1];
    if (!value || value.startsWith("--")) throw new Error(`Required ${key}`);
    return value;
  };
  const manifest = validateManifest(
    JSON.parse(await readFile(get("--manifest"), "utf8")),
  );
  if (transferDigest(manifest) !== get("--approved-manifest-sha256"))
    throw new Error("Manifest is not the approved allowlist");
  const actorId = get("--actor");
  if (!args.includes("--apply") && !args.includes("--rollback")) {
    const plan = await dryRunIncludeTransfer(actorId, manifest);
    await durableWrite(get("--plan"), plan);
    console.log(
      JSON.stringify({
        mode: "dry-run",
        batchId: manifest.batchId,
        groups: manifest.expectedGroups,
        targets: manifest.expectedTargets,
        planDigest: plan.digest,
      }),
    );
    return;
  }
  if (process.env.INCLUDE_TRANSFER_APPROVED_BATCH !== manifest.batchId)
    throw new Error("Explicit reviewed batch execution approval is required");
  const plan = JSON.parse(
    await readFile(get("--plan"), "utf8"),
  ) as IncludeTransferPlan;
  const result = args.includes("--rollback")
    ? await rollbackIncludeTransfer(
        actorId,
        manifest,
        plan,
        JSON.parse(await readFile(get("--backup"), "utf8")),
      )
    : await applyIncludeTransfer(actorId, manifest, plan, (before) =>
        durableWrite(get("--backup"), before),
      );
  console.log(
    JSON.stringify({
      mode: args.includes("--rollback") ? "rollback" : "apply",
      batchId: manifest.batchId,
      ...result,
    }),
  );
}
main()
  .catch(() => {
    console.error(
      "Historical INCLUDE transfer failed or commit outcome is uncertain. No blind retry: inspect the deterministic batch marker using the same manifest/plan. Error details are deliberately not printed because database errors can contain credentials or rationale.",
    );
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
