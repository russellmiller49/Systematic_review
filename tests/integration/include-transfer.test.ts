import { beforeAll, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, stat, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { prisma } from "@/server/db";
import { pooledReadinessFixture } from "../fixtures/pooled-readiness";
import { resetDb } from "../db-utils";
import { createTestUser } from "../factories";
import {
  applyIncludeTransfer,
  dryRunIncludeTransfer,
  rollbackIncludeTransfer,
  transferDigest,
  transferRowId,
  validateManifest,
  type IncludeTransferManifest,
} from "@/server/services/screening/include-transfer";
import { updateExclusionReason } from "@/server/services/protocols";
import { listPooledConflicts } from "@/server/services/screening/pooled-adjudication";

beforeAll(async () => {
  const url = new URL(process.env.TEST_DATABASE_URL ?? "");
  if (
    !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) ||
    !/(^|[_-])test([_-]|$)/i.test(url.pathname.slice(1))
  )
    throw new Error("Local test DB required");
  await resetDb();
});
async function fixture(count = 1) {
  const f = await pooledReadinessFixture({ count: 0, reviewers: 2 });
  const source = await createTestUser({ name: "Historical adjudicator" });
  await prisma.organizationMember.create({
    data: { orgId: f.org.id, userId: source.id, role: "MEMBER" },
  });
  await prisma.projectMember.createMany({
    data: [f.guideline, ...f.picos].map((p) => ({
      projectId: p.id,
      userId: source.id,
      roles: ["ADJUDICATOR"],
    })),
  });
  const manifest: IncludeTransferManifest = {
    version: 1,
    batchId: randomUUID(),
    guidelineId: f.guideline.id,
    poolId: f.pool.id,
    sourceAdjudicatorId: source.id,
    sourceProjectId: f.picos[1]!.id,
    expectedGroups: count,
    expectedTargets: 0,
    groups: [],
  };
  for (let i = 0; i < count; i++) {
    const copies = count === 40 ? (i < 17 ? 5 : 4) : 3;
    const ids: string[] = [];
    let sourceAdjudicationId = "",
      sourceDigest = "",
      sourceConflictDigest = "",
      sourceResultDigest = "";
    for (let j = 0; j < copies; j++) {
      const projectId = f.picos[j + 1]!.id;
      const stageId = f.stages.find((s) => s.projectId === projectId)!.id;
      const c = await prisma.citation.create({
        data: {
          projectId,
          title: `Transfer ${i}`,
          normalizedTitle: `transfer ${i}`,
          doi: `10.7000/transfer-${i}`,
          authors: [],
        },
      });
      ids.push(c.id);
      await prisma.screeningAssignment.createMany({
        data: f.users.map((u) => ({
          stageId,
          citationId: c.id,
          reviewerId: u.id,
          status: "COMPLETED",
        })),
      });
      await prisma.screeningDecision.createMany({
        data: f.users.map((u, k) => ({
          stageId,
          citationId: c.id,
          reviewerId: u.id,
          decision: k === 0 ? "INCLUDE" : "EXCLUDE",
          notes: "Same original evidence",
        })),
      });
      const conflict = await prisma.screeningConflict.create({
        data: {
          stageId,
          citationId: c.id,
          status: j === 0 ? "RESOLVED" : "OPEN",
          resolvedAt: j === 0 ? new Date("2026-10-20T18:55:08.118Z") : null,
        },
      });
      if (j === 0) {
        const a = await prisma.screeningAdjudication.create({
          data: {
            conflictId: conflict.id,
            adjudicatorId: source.id,
            finalDecision: "INCLUDE",
            reason: "Full-text review is warranted",
            createdAt: new Date("2026-10-20T18:55:08.116Z"),
          },
        });
        sourceAdjudicationId = a.id;
        sourceDigest = transferDigest(a);
        const result = await prisma.citationStageResult.create({
          data: {
            stageId,
            citationId: c.id,
            outcome: "INCLUDE",
            resolvedVia: "ADJUDICATION",
            resolvedAt: new Date("2026-10-20T18:55:08.120Z"),
          },
        });
        sourceConflictDigest = transferDigest(conflict);
        sourceResultDigest = transferDigest(result);
      }
    }
    manifest.groups.push({
      sourceAdjudicationId,
      sourceDigest,
      sourceConflictDigest,
      sourceResultDigest,
      citationIds: ids,
      targetCitationIds: ids.slice(1),
    });
    manifest.expectedTargets += ids.length - 1;
  }
  return { ...f, source, manifest };
}
const capture = () => {
  let image: unknown;
  const backup = async (value: unknown) => {
    image = JSON.parse(JSON.stringify(value));
    return {
      sha256: transferDigest(value),
      location: "/private/test-before.json",
    };
  };
  return {
    backup,
    get image() {
      return image;
    },
  };
};
async function preserved(f: Awaited<ReturnType<typeof fixture>>) {
  const ids = f.manifest.groups.flatMap((g) => g.citationIds);
  return {
    decisions: await prisma.screeningDecision.findMany({
      where: { citationId: { in: ids } },
      orderBy: { id: "asc" },
    }),
    assignments: await prisma.screeningAssignment.findMany({
      where: { citationId: { in: ids } },
      orderBy: { id: "asc" },
    }),
    sources: await prisma.screeningAdjudication.findMany({
      where: {
        id: { in: f.manifest.groups.map((g) => g.sourceAdjudicationId) },
      },
      orderBy: { id: "asc" },
    }),
  };
}
it("transfers exactly 40/137 atomically, preserves history, attributes effective time, retries and compensates", async () => {
  const f = await fixture(40);
  expect(f.manifest.expectedTargets).toBe(137);
  // A withdrawn historical vote with a pending assignment is not live evidence.
  const c = f.manifest.groups[0]!.citationIds[0]!;
  const stage = (
    await prisma.screeningConflict.findFirstOrThrow({
      where: { citationId: c },
    })
  ).stageId;
  await prisma.screeningAssignment.create({
    data: {
      stageId: stage,
      citationId: c,
      reviewerId: f.owner.id,
      status: "PENDING",
    },
  });
  await prisma.screeningDecision.create({
    data: {
      stageId: stage,
      citationId: c,
      reviewerId: f.owner.id,
      decision: "MAYBE",
      withdrawnAt: new Date(),
      withdrawalId: "historical-withdrawal",
    },
  });
  const before = await preserved(f);
  const plan = await dryRunIncludeTransfer(f.owner.id, f.manifest);
  expect(await preserved(f)).toEqual(before);
  const saved = capture();
  const started = Date.now();
  expect(
    await applyIncludeTransfer(f.owner.id, f.manifest, plan, saved.backup),
  ).toEqual({ alreadyApplied: false, targets: 137 });
  console.log(`40/137 migration apply duration: ${Date.now() - started}ms`);
  expect(await preserved(f)).toEqual(before);
  expect(
    await applyIncludeTransfer(f.owner.id, f.manifest, plan, async () => {
      throw new Error("must not back up twice");
    }),
  ).toEqual({ alreadyApplied: true, targets: 137 });
  const target = f.manifest.groups[0]!.targetCitationIds[0]!;
  const a = await prisma.screeningAdjudication.findUniqueOrThrow({
    where: { id: transferRowId(f.manifest.batchId, "adjudication", target) },
  });
  expect(a.adjudicatorId).toBe(f.source.id);
  expect(a.createdAt.toISOString()).toBe("2026-10-20T18:55:08.118Z");
  const event = await prisma.auditEvent.findUniqueOrThrow({
    where: { id: transferRowId(f.manifest.batchId, "audit", target) },
  });
  expect(event.userId).toBe(f.owner.id);
  expect(event.createdAt.getTime()).toBeGreaterThan(a.createdAt.getTime());
  expect(event.metadata).toMatchObject({
    sourceDecisionAt: "2026-10-20T18:55:08.118Z",
    sourceRowCreatedAt: "2026-10-20T18:55:08.116Z",
  });
  expect(
    await rollbackIncludeTransfer(f.owner.id, f.manifest, plan, saved.image),
  ).toEqual({ alreadyRolledBack: false, targets: 137 });
  expect(await preserved(f)).toEqual(before);
  expect(await dryRunIncludeTransfer(f.owner.id, f.manifest)).toEqual(plan);
  expect(
    await rollbackIncludeTransfer(f.owner.id, f.manifest, plan, saved.image),
  ).toEqual({ alreadyRolledBack: true, targets: 137 });
  await expect(
    applyIncludeTransfer(f.owner.id, f.manifest, plan, saved.backup),
  ).rejects.toThrow("rolled back");
}, 60000);
it("fails closed for source impersonation, removed authority, tampered allowlist and backup failure", async () => {
  const f = await fixture();
  await expect(dryRunIncludeTransfer(f.source.id, f.manifest)).rejects.toThrow(
    "distinct",
  );
  expect(() =>
    validateManifest({ ...f.manifest, expectedTargets: 99 }),
  ).toThrow();
  const plan = await dryRunIncludeTransfer(f.owner.id, f.manifest);
  const before = await preserved(f);
  await expect(
    applyIncludeTransfer(f.owner.id, f.manifest, plan, async () => {
      throw new Error("disk failed");
    }),
  ).rejects.toThrow("disk failed");
  expect(await preserved(f)).toEqual(before);
  expect(
    await prisma.auditEvent.count({
      where: { id: transferRowId(f.manifest.batchId, "batch", f.pool.id) },
    }),
  ).toBe(0);
  await prisma.projectMember.update({
    where: {
      projectId_userId: { projectId: f.picos[3]!.id, userId: f.owner.id },
    },
    data: { status: "REMOVED" },
  });
  await expect(
    applyIncludeTransfer(f.owner.id, f.manifest, plan, capture().backup),
  ).rejects.toThrow();
});
it.each([
  "vote",
  "assignment",
  "identity",
  "source",
  "source-time",
  "protocol",
  "downstream",
  "target",
])("rejects changed %s between plan and apply", async (change) => {
  const f = await fixture();
  const plan = await dryRunIncludeTransfer(f.owner.id, f.manifest);
  const target = f.manifest.groups[0]!.targetCitationIds[0]!;
  const conflict = await prisma.screeningConflict.findFirstOrThrow({
    where: { citationId: target },
  });
  if (change === "vote")
    await prisma.screeningDecision.updateMany({
      where: { citationId: target },
      data: { notes: "changed" },
    });
  if (change === "assignment")
    await prisma.screeningAssignment.create({
      data: {
        stageId: conflict.stageId,
        citationId: target,
        reviewerId: f.owner.id,
        status: "PENDING",
      },
    });
  if (change === "identity")
    await prisma.citation.update({
      where: { id: target },
      data: { doi: "10.9999/conflicting" },
    });
  if (change === "source")
    await prisma.screeningAdjudication.update({
      where: { id: f.manifest.groups[0]!.sourceAdjudicationId },
      data: { reason: "changed source" },
    });
  if (change === "source-time")
    await prisma.screeningConflict.updateMany({
      where: { citationId: f.manifest.groups[0]!.citationIds[0] },
      data: { resolvedAt: new Date() },
    });
  if (change === "protocol")
    await prisma.protocol.updateMany({
      where: { projectId: f.picos[2]!.id },
      data: { reviewQuestion: "Changed clinical scope" },
    });
  if (change === "downstream") {
    const stage = await prisma.screeningStage.findFirstOrThrow({
      where: { projectId: f.picos[2]!.id, type: "FULL_TEXT" },
    });
    await prisma.screeningAssignment.create({
      data: {
        stageId: stage.id,
        citationId: target,
        reviewerId: f.users[0]!.id,
      },
    });
  }
  if (change === "target")
    await prisma.citationStageResult.create({
      data: {
        stageId: conflict.stageId,
        citationId: target,
        outcome: "EXCLUDE",
        resolvedVia: "CONSENSUS",
      },
    });
  let backups = 0;
  await expect(
    applyIncludeTransfer(f.owner.id, f.manifest, plan, async () => {
      backups++;
      return { sha256: "", location: "" };
    }),
  ).rejects.toThrow();
  expect(backups).toBe(0);
  expect(
    await prisma.screeningAdjudication.count({
      where: {
        id: { startsWith: "transfer_" },
        conflict: { citationId: target },
      },
    }),
  ).toBe(0);
});
it("rejects rollback after any target change and preserves original time in reopened history", async () => {
  const f = await fixture();
  const plan = await dryRunIncludeTransfer(f.owner.id, f.manifest);
  const saved = capture();
  await applyIncludeTransfer(f.owner.id, f.manifest, plan, saved.backup);
  const target = f.manifest.groups[0]!.targetCitationIds[0]!;
  await prisma.screeningConflict.updateMany({
    where: { citationId: target },
    data: { status: "OPEN", resolvedAt: null },
  });
  await expect(
    rollbackIncludeTransfer(f.owner.id, f.manifest, plan, saved.image),
  ).rejects.toThrow("changed");
  await expect(
    applyIncludeTransfer(f.owner.id, f.manifest, plan, saved.backup),
  ).rejects.toThrow("changed");
  const list = await listPooledConflicts(
    { userId: f.owner.id },
    f.guideline.id,
    { poolId: f.pool.id },
  );
  const historical = list.items
    .flatMap((i) => i.historicalAdjudications)
    .find((h) => h.citationId === target);
  expect(historical?.effectiveAt?.toISOString()).toBe(
    "2026-10-20T18:55:08.118Z",
  );
});
it("rolls back all target writes when a late audit insert fails", async () => {
  const f = await fixture();
  const plan = await dryRunIncludeTransfer(f.owner.id, f.manifest);
  const before = await preserved(f);
  const target = f.manifest.groups[0]!.targetCitationIds[0]!;
  await expect(
    applyIncludeTransfer(f.owner.id, f.manifest, plan, async (image) => {
      // A synthetic deterministic-ID collision forces failure AFTER target bulk writes.
      await prisma.auditEvent.create({
        data: {
          id: transferRowId(f.manifest.batchId, "audit", target),
          projectId: f.guideline.id,
          userId: f.owner.id,
          entityType: "Test",
          entityId: "collision",
          action: "test.collision",
        },
      });
      return {
        sha256: transferDigest(image),
        location: "/private/test-before.json",
      };
    }),
  ).rejects.toThrow();
  expect(await preserved(f)).toEqual(before);
  expect(
    await prisma.screeningAdjudication.count({
      where: {
        id: {
          in: f.manifest.groups[0]!.targetCitationIds.map((c) =>
            transferRowId(f.manifest.batchId, "adjudication", c),
          ),
        },
      },
    }),
  ).toBe(0);
  expect(
    await prisma.screeningConflict.count({
      where: {
        citationId: { in: f.manifest.groups[0]!.targetCitationIds },
        status: "OPEN",
      },
    }),
  ).toBe(2);
});
it("serializes downstream FK inserts behind approved citation guards", async () => {
  const f = await fixture();
  const plan = await dryRunIncludeTransfer(f.owner.id, f.manifest);
  const target = f.manifest.groups[0]!.targetCitationIds[0]!;
  const stage = await prisma.screeningStage.findFirstOrThrow({
    where: { projectId: f.picos[2]!.id, type: "FULL_TEXT" },
  });
  let release!: () => void;
  const held = new Promise<void>((r) => (release = r));
  let ready!: () => void;
  const acquired = new Promise<void>((r) => (ready = r));
  const running = applyIncludeTransfer(
    f.owner.id,
    f.manifest,
    plan,
    async (image) => {
      ready();
      await held;
      return {
        sha256: transferDigest(image),
        location: "/private/test-before.json",
      };
    },
  );
  await acquired;
  let completed = false;
  const insert = prisma.screeningAssignment
    .create({
      data: {
        stageId: stage.id,
        citationId: target,
        reviewerId: f.users[0]!.id,
      },
    })
    .then(() => {
      completed = true;
    });
  try {
    await new Promise((r) => setTimeout(r, 100));
    expect(completed).toBe(false);
  } finally {
    release();
  }
  await running;
  await insert;
  await expect(
    applyIncludeTransfer(f.owner.id, f.manifest, plan, capture().backup),
  ).rejects.toThrow("Downstream");
});
it("runs default-dry-run CLI, durable backup, explicit apply, retry and guarded rollback", async () => {
  const f = await fixture();
  const dir = await mkdtemp(join(tmpdir(), "include-transfer-test-"));
  const manifestPath = join(dir, "manifest.json"),
    planPath = join(dir, "plan.json"),
    backupPath = join(dir, "backup.json");
  const run = promisify(execFile);
  const args = [
    "--import",
    "tsx",
    "scripts/transfer-historical-includes.ts",
    "--manifest",
    manifestPath,
    "--actor",
    f.owner.id,
    "--approved-manifest-sha256",
    transferDigest(f.manifest),
    "--plan",
    planPath,
  ];
  const env = {
    ...process.env,
    DATABASE_URL: process.env.TEST_DATABASE_URL,
    INCLUDE_TRANSFER_APPROVED_BATCH: f.manifest.batchId,
  };
  try {
    await writeFile(manifestPath, JSON.stringify(f.manifest), { mode: 0o600 });
    const before = await preserved(f);
    const dry = await run(process.execPath, args, { env });
    expect(JSON.parse(dry.stdout)).toMatchObject({
      mode: "dry-run",
      targets: 2,
    });
    expect(await preserved(f)).toEqual(before);
    await expect(
      run(process.execPath, [...args, "--apply", "--backup", backupPath], {
        env: { ...env, INCLUDE_TRANSFER_APPROVED_BATCH: "" },
      }),
    ).rejects.toThrow();
    const apply = await run(
      process.execPath,
      [...args, "--apply", "--backup", backupPath],
      { env },
    );
    expect(JSON.parse(apply.stdout)).toMatchObject({
      mode: "apply",
      alreadyApplied: false,
    });
    expect((await stat(backupPath)).mode & 0o777).toBe(0o600);
    const backupText = await readFile(backupPath, "utf8");
    expect(backupText).not.toContain("passwordHash");
    expect(backupText).not.toContain(process.env.TEST_DATABASE_URL!);
    const retry = await run(
      process.execPath,
      [...args, "--apply", "--backup", backupPath],
      { env },
    );
    expect(JSON.parse(retry.stdout)).toMatchObject({ alreadyApplied: true });
    expect(await readFile(backupPath, "utf8")).toBe(backupText);
    const rollback = await run(
      process.execPath,
      [...args, "--rollback", "--backup", backupPath],
      { env },
    );
    expect(JSON.parse(rollback.stdout)).toMatchObject({
      mode: "rollback",
      alreadyRolledBack: false,
    });
    expect(await preserved(f)).toEqual(before);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}, 30000);
it("rejects coordinated reason-label changes even when cross-copy reviewer evidence still agrees", async () => {
  const f = await fixture();
  const citations = await prisma.citation.findMany({
    where: { id: { in: f.manifest.groups[0]!.citationIds } },
  });
  const reasons = [];
  for (const c of citations) {
    const reason = await prisma.exclusionReason.findFirstOrThrow({
      where: { projectId: c.projectId, label: "Wrong population" },
    });
    reasons.push(reason);
    await prisma.screeningDecision.updateMany({
      where: { citationId: c.id, decision: "EXCLUDE" },
      data: { exclusionReasonId: reason.id },
    });
  }
  const plan = await dryRunIncludeTransfer(f.owner.id, f.manifest);
  for (const reason of reasons)
    await updateExclusionReason(
      { userId: f.owner.id },
      reason.projectId,
      reason.id,
      { label: "Updated population criterion" },
    );
  const fresh = await dryRunIncludeTransfer(f.owner.id, f.manifest);
  expect(fresh.digest).not.toBe(plan.digest);
  let backedUp = false;
  await expect(
    applyIncludeTransfer(f.owner.id, f.manifest, plan, async () => {
      backedUp = true;
      throw new Error("must not reach backup");
    }),
  ).rejects.toThrow("Preconditions changed");
  expect(backedUp).toBe(false);
});
it("serializes reason writers behind migration project context guards", async () => {
  const f = await fixture();
  const plan = await dryRunIncludeTransfer(f.owner.id, f.manifest);
  const reason = await prisma.exclusionReason.findFirstOrThrow({
    where: { projectId: f.picos[2]!.id, label: "Wrong population" },
  });
  let release!: () => void;
  const held = new Promise<void>((r) => (release = r));
  let ready!: () => void;
  const acquired = new Promise<void>((r) => (ready = r));
  const running = applyIncludeTransfer(
    f.owner.id,
    f.manifest,
    plan,
    async (image) => {
      ready();
      await held;
      return {
        sha256: transferDigest(image),
        location: "/private/test-before.json",
      };
    },
  );
  await acquired;
  let completed = false;
  const edit = updateExclusionReason(
    { userId: f.owner.id },
    reason.projectId,
    reason.id,
    { label: "Later criterion" },
  ).then(() => {
    completed = true;
  });
  try {
    await new Promise((r) => setTimeout(r, 100));
    expect(completed).toBe(false);
  } finally {
    release();
  }
  await running;
  await edit;
  await expect(
    applyIncludeTransfer(f.owner.id, f.manifest, plan, capture().backup),
  ).rejects.toThrow("changed");
});
