import { beforeAll, expect, it, vi } from "vitest";
import { prisma } from "@/server/db";
import * as recovery from "@/server/services/screening/withdrawal";
import * as screening from "@/server/services/screening";
import * as pooled from "@/server/services/screening/pooled";
import * as quotas from "@/server/services/screening/quotas";
import { getDashboard } from "@/server/services/dashboard";
import { computePrismaCounts } from "@/server/services/prisma-report";
import { createExport, downloadExport } from "@/server/services/exports";
import { listAuditEvents } from "@/server/services/audit-query";
import * as audit from "@/server/services/audit";
import { signPlan } from "@/server/services/screening/recovery-token";
import { resetDb } from "../db-utils";
import { pooledReadinessFixture } from "../fixtures/pooled-readiness";
import {
  createTestCitation,
  createTestUser,
  addOrgMember,
  addProjectMember,
} from "../factories";

beforeAll(resetDb);
type Fixture = Awaited<ReturnType<typeof fixture>>;
async function fixture(count = 4) {
  const f = await pooledReadinessFixture({ count });
  // Five pooled PICOs, with a duplicate copy in one PICO: six rows, one review.
  const first = await prisma.citation.findUniqueOrThrow({
    where: { id: f.groups[0]![0]!.id },
  });
  for (const project of f.picos.slice(1)) {
    if (f.groups[0]!.some((c) => c.projectId === project.id)) continue;
    const c = await createTestCitation(project.id, {
      title: first.title,
      doi: first.doi,
      pmid: first.pmid,
    });
    f.groups[0]!.push({
      id: c.id,
      projectId: c.projectId,
      stageId: f.stages.find((s) => s.projectId === c.projectId)!.id,
    });
  }
  const duplicate = await createTestCitation(first.projectId, {
    title: first.title,
    doi: first.doi,
    pmid: first.pmid,
  });
  f.groups[0]!.push({
    id: duplicate.id,
    projectId: duplicate.projectId,
    stageId: f.groups[0]![0]!.stageId,
  });
  return f;
}
const ownerCtx = (f: Fixture) => ({ userId: f.owner.id });
const preview = (f: Fixture) =>
  recovery.previewWithdrawal(ownerCtx(f), f.guideline.id, {
    poolId: f.pool.id,
    reviewerId: f.users[0]!.id,
    reason: "Incorrect screening scope; repeat review",
  });
async function withdraw(f: Fixture) {
  const p = await preview(f);
  expect(p.token).toBeTruthy();
  return recovery.executeRecovery(ownerCtx(f), f.guideline.id, p.token!);
}
async function rows(f: Fixture) {
  return prisma.screeningDecision.findMany({
    where: { stage: { project: { parentProjectId: f.guideline.id } } },
    orderBy: { id: "asc" },
  });
}

it("preflights read-only; withdraws six copies once; preserves other votes, PICO 1 and original values; retries and restores", async () => {
  const f = await fixture();
  await f.decide(0, 0, "EXCLUDE", "Original retained note");
  await f.decide(1, 0, "INCLUDE", "Private other reviewer note");
  await f.decide(0, 1, "INCLUDE");
  await f.decide(0, 2, "MAYBE");
  await f.decide(0, 3, "EXCLUDE"); // Selection includes exclusions outside the first PICO's search.
  const solo = await createTestCitation(f.picos[0]!.id);
  const soloStage = f.stages.find((s) => s.projectId === f.picos[0]!.id)!;
  await prisma.screeningAssignment.create({
    data: {
      stageId: soloStage.id,
      citationId: solo.id,
      reviewerId: f.users[0]!.id,
    },
  });
  await screening.createDecision(
    { userId: f.users[0]!.id },
    f.picos[0]!.id,
    soloStage.id,
    { citationId: solo.id, decision: "EXCLUDE" },
  );
  const before = await rows(f);
  const auditBefore = await prisma.auditEvent.count();
  const p = await preview(f);
  expect(p.summary).toMatchObject({
    selectedGroups: 2,
    eligibleGroups: 2,
    heldGroups: 0,
    linkedDecisions: 9,
    completedBefore: 4,
    remainingBefore: 6,
  });
  expect(JSON.stringify(p)).not.toContain("Private other reviewer note");
  expect(await rows(f)).toEqual(before);
  expect(await prisma.auditEvent.count()).toBe(auditBefore);
  expect(await prisma.screeningWithdrawal.count()).toBe(0);
  const result = await recovery.executeRecovery(
    ownerCtx(f),
    f.guideline.id,
    p.token!,
  );
  expect(result.summary).toMatchObject({
    completedAfter: 2,
    remainingAfter: 8,
  });
  const after = await rows(f);
  const selected = before.filter(
    (d) =>
      d.reviewerId === f.users[0]!.id &&
      d.decision === "EXCLUDE" &&
      d.stageId !== soloStage.id,
  );
  for (const d of before) {
    const current = after.find((r) => r.id === d.id)!;
    if (selected.some((s) => s.id === d.id)) {
      expect(current).toMatchObject({
        ...d,
        updatedAt: expect.any(Date),
        withdrawnAt: expect.any(Date),
        withdrawalId: result.withdrawalId,
      });
    } else expect(current).toEqual(d);
  }
  expect(
    await prisma.screeningConflict.count({
      where: {
        stage: { project: { parentProjectId: f.guideline.id } },
        status: "OPEN",
      },
    }),
  ).toBe(0);
  const queue = await f.queue(0, { status: "MY_REVIEWED" });
  expect(queue.pagination.total).toBe(2);
  const available = await f.queue();
  expect(available.pagination.total).toBe(2);
  expect(
    await screening.listDecisions(
      { userId: f.users[0]!.id },
      f.groups[0]![0]!.projectId,
      f.groups[0]![0]!.stageId,
      f.groups[0]![0]!.id,
    ),
  ).toEqual([]);
  const ownAudit = await listAuditEvents(
    { userId: f.users[0]!.id },
    f.guideline.id,
    { entityType: "ScreeningWithdrawal" },
  );
  expect(ownAudit.events).toEqual([]); // Admin recovery event cannot leak target status to co-reviewers.
  const audited = await listAuditEvents(ownerCtx(f), f.guideline.id, {
    entityType: "ScreeningWithdrawal",
  });
  expect(audited.events).toHaveLength(1);
  expect(
    await recovery.executeRecovery(ownerCtx(f), f.guideline.id, p.token!),
  ).toMatchObject({ replayed: true, withdrawalId: result.withdrawalId });
  expect(await prisma.auditEvent.count()).toBe(
    auditBefore + selected.length + 6 + 1,
  );
  const restore = await recovery.previewRestoration(
    ownerCtx(f),
    f.guideline.id,
    { withdrawalId: result.withdrawalId, reason: "Restore reviewed batch" },
  );
  expect(restore.summary.eligibleGroups).toBe(2);
  const restored = await recovery.executeRecovery(
    ownerCtx(f),
    f.guideline.id,
    restore.token!,
  );
  expect(restored.summary).toMatchObject({
    completedAfter: 4,
    remainingAfter: 6,
  });
  const restoredRows = await rows(f);
  for (const d of before)
    expect(restoredRows.find((r) => r.id === d.id)).toMatchObject({
      ...d,
      updatedAt: selected.some((s) => s.id === d.id)
        ? expect.any(Date)
        : d.updatedAt,
    });
  expect(
    await prisma.screeningConflict.count({
      where: {
        stage: { project: { parentProjectId: f.guideline.id } },
        status: "OPEN",
      },
    }),
  ).toBe(6);
  expect(
    await recovery.executeRecovery(ownerCtx(f), f.guideline.id, restore.token!),
  ).toMatchObject({ replayed: true });
  await expect(
    recovery.executeRecovery(ownerCtx(f), f.guideline.id, p.token!),
  ).rejects.toMatchObject({ code: "INVALID_STATE" });
});

it("all current readers ignore withdrawn votes while historical safeguards retain them", async () => {
  const f = await fixture(1);
  await f.decide(0, 0, "EXCLUDE");
  await withdraw(f);
  const copy = f.groups[0]![0]!;
  const stages = await screening.listStages(ownerCtx(f), copy.projectId);
  expect(
    stages.find((s) => s.id === copy.stageId)?.progress.decidedCitations,
  ).toBe(0);
  expect(
    (await getDashboard(ownerCtx(f), copy.projectId)).stats.screening.find(
      (s) => s.type === "TITLE_ABSTRACT",
    )?.decided,
  ).toBe(0);
  expect(
    (await computePrismaCounts(copy.projectId)).counts.find(
      (c) => c.key === "records_screened",
    )?.value,
  ).toBe(0);
  const admin = await screening.listAssignmentAdmin(
    ownerCtx(f),
    copy.projectId,
    copy.stageId,
  );
  expect(
    admin.reviewers.find((r) => r.reviewer.id === f.users[0]!.id)?.decisions,
  ).toBe(0);
  await pooled.deleteGuidelineScreeningPool(ownerCtx(f), f.guideline.id);
  const nav = await screening.getScreeningNavigator(
    { userId: f.users[0]!.id },
    copy.projectId,
    copy.stageId,
    { status: "UNDECIDED", page: 1, limit: 50 },
  );
  expect(nav.summary.decided).toBe(0);
  const job = await createExport(ownerCtx(f), copy.projectId, {
    kind: "SCREENING",
    format: "JSON",
  });
  const exported = await downloadExport(ownerCtx(f), copy.projectId, job.id);
  expect(JSON.parse(exported.body).decisions).toEqual([]);
  const assignmentIds = await prisma.screeningAssignment.findMany({
    where: { stageId: copy.stageId },
    select: { id: true },
  });
  await screening.resetPendingAssignments(
    ownerCtx(f),
    copy.projectId,
    copy.stageId,
    { reason: "Synthetic pending reset" },
  );
  expect(
    await prisma.screeningAssignment.findMany({
      where: { id: { in: assignmentIds.map((a) => a.id) } },
    }),
  ).toHaveLength(assignmentIds.length);
  expect(
    await prisma.screeningDecision.count({
      where: {
        withdrawalId: { not: null },
        citationId: { in: f.groups[0]!.map((c) => c.id) },
      },
    }),
  ).toBe(6);
  const reason = await prisma.exclusionReason.findFirstOrThrow({
    where: { projectId: copy.projectId, label: "Wrong population" },
  });
  await screening.batchExclude(
    { userId: f.users[0]!.id },
    copy.projectId,
    copy.stageId,
    { citationIds: [copy.id], exclusionReasonId: reason.id },
  );
  expect(
    await prisma.screeningDecision.findUnique({
      where: {
        stageId_citationId_reviewerId: {
          stageId: copy.stageId,
          citationId: copy.id,
          reviewerId: f.users[0]!.id,
        },
      },
    }),
  ).toMatchObject({ withdrawnAt: null, withdrawalId: null });
});

it("held finalized and inconsistent groups do not prevent recovery of an independent eligible group", async () => {
  const f = await fixture(3);
  for (let i = 0; i < 3; i++) await f.decide(0, i, "EXCLUDE");
  await f.decide(1, 1, "EXCLUDE"); // Final consensus: cannot undo.
  await prisma.screeningDecision.update({
    where: {
      stageId_citationId_reviewerId: {
        stageId: f.groups[2]![0]!.stageId,
        citationId: f.groups[2]![0]!.id,
        reviewerId: f.users[0]!.id,
      },
    },
    data: { notes: "Differing copy" },
  });
  const p = await preview(f);
  expect(p.summary).toMatchObject({
    selectedGroups: 3,
    eligibleGroups: 1,
    heldGroups: 2,
    linkedDecisions: 6,
  });
  expect(
    p.groups.find((g) => g.citationIds.includes(f.groups[1]![0]!.id))?.reasons,
  ).toContain("FINALIZED_STAGE_RESULT");
  expect(
    p.groups.find((g) => g.citationIds.includes(f.groups[2]![0]!.id))?.reasons,
  ).toContain("INCONSISTENT_LINKED_STATE");
  await recovery.executeRecovery(ownerCtx(f), f.guideline.id, p.token!);
  expect(
    await prisma.screeningDecision.count({
      where: {
        withdrawalId: { not: null },
        citationId: {
          in: f.groups.slice(1).flatMap((g) => g.map((c) => c.id)),
        },
      },
    }),
  ).toBe(0);
});

it("holds downstream history and resolved adjudication history even after stage reopening", async () => {
  const f = await fixture(2);
  await f.decide(0, 0, "EXCLUDE");
  await f.decide(0, 1, "EXCLUDE");
  const copy = f.groups[0]![0]!;
  const ft = await prisma.screeningStage.findFirstOrThrow({
    where: { projectId: copy.projectId, type: "FULL_TEXT" },
  });
  await prisma.screeningAssignment.create({
    data: { stageId: ft.id, citationId: copy.id, reviewerId: f.users[0]!.id },
  });
  const second = f.groups[1]![0]!;
  await prisma.screeningConflict.create({
    data: {
      citationId: second.id,
      stageId: second.stageId,
      status: "RESOLVED",
    },
  });
  const p = await preview(f);
  expect(p.token).toBeNull();
  expect(
    p.groups.find((g) => g.citationIds.includes(copy.id))?.reasons,
  ).toContain("DOWNSTREAM_HISTORY");
  expect(
    p.groups.find((g) => g.citationIds.includes(second.id))?.reasons,
  ).toContain("ADJUDICATION_HISTORY");
});

it.each([
  "co-review",
  "target-revision",
  "quota",
  "new-copy",
  "pool",
  "role",
] as const)(
  "rejects stale preflight after %s changes without partial writes",
  async (change) => {
    const f = await fixture(1);
    await f.decide(0, 0, "EXCLUDE");
    const p = await preview(f);
    if (change === "co-review") await f.decide(1, 0, "INCLUDE");
    if (change === "target-revision") await f.decide(0, 0, "MAYBE");
    if (change === "quota")
      await quotas.saveQuotas(
        ownerCtx(f),
        f.guideline.id,
        { poolId: f.pool.id },
        { reviewers: [{ reviewerId: f.users[0]!.id, target: 20 }] },
      );
    if (change === "new-copy")
      await createTestCitation(f.groups[0]![0]!.projectId, {
        title: "New overlapping copy",
        doi: "10.6000/readiness-0",
      });
    if (change === "pool")
      await pooled.saveGuidelineScreeningPool(ownerCtx(f), f.guideline.id, {
        name: "Changed pool",
        projectIds: f.picos.slice(2).map((p) => p.id),
      });
    if (change === "role")
      await prisma.projectMember.update({
        where: {
          projectId_userId: {
            projectId: f.picos[2]!.id,
            userId: f.users[0]!.id,
          },
        },
        data: { roles: ["OBSERVER"] },
      });
    const before = await rows(f);
    await expect(
      recovery.executeRecovery(ownerCtx(f), f.guideline.id, p.token!),
    ).rejects.toMatchObject({
      code: change === "role" ? "FORBIDDEN" : "INVALID_STATE",
    });
    expect(await rows(f)).toEqual(before);
    expect(
      await prisma.screeningWithdrawal.count({
        where: { guidelineId: f.guideline.id },
      }),
    ).toBe(0);
  },
);

it("requires current owner/admin rights in the entire family, current target participation, and actor-bound plans", async () => {
  const f = await fixture(1);
  await f.decide(0, 0, "EXCLUDE");
  const p = await preview(f);
  const raw = {
    poolId: f.pool.id,
    reviewerId: f.users[0]!.id,
    reason: "Synthetic scope repair",
  };
  for (const role of [
    "REVIEWER",
    "ADJUDICATOR",
    "LIBRARIAN",
    "OBSERVER",
  ] as const) {
    await prisma.projectMember.update({
      where: {
        projectId_userId: { projectId: f.guideline.id, userId: f.users[1]!.id },
      },
      data: { roles: [role] },
    });
    await expect(
      recovery.previewWithdrawal(
        { userId: f.users[1]!.id },
        f.guideline.id,
        raw,
      ),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(
      recovery.listWithdrawals({ userId: f.users[1]!.id }, f.guideline.id),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  }
  await expect(
    recovery.executeRecovery(
      { userId: f.users[1]!.id },
      f.guideline.id,
      p.token!,
    ),
  ).rejects.toMatchObject({ code: "FORBIDDEN" });
  const other = await createTestUser();
  await addOrgMember(f.org.id, other.id);
  await addProjectMember(f.guideline.id, other.id, ["ADMIN"]);
  await expect(
    recovery.previewWithdrawal({ userId: other.id }, f.guideline.id, raw),
  ).rejects.toMatchObject({ code: "FORBIDDEN" });
  await prisma.projectMember.update({
    where: {
      projectId_userId: { projectId: f.picos[3]!.id, userId: f.users[0]!.id },
    },
    data: { status: "REMOVED" },
  });
  await expect(preview(f)).rejects.toMatchObject({ code: "FORBIDDEN" });
  expect((await rows(f)).every((d) => !d.withdrawnAt)).toBe(true);
});

it.each(["re-review", "capacity", "quota", "copy", "finalized"] as const)(
  "guards restoration after %s changes",
  async (change) => {
    const f = await fixture(1);
    await f.decide(0, 0, "EXCLUDE");
    const batch = await withdraw(f);
    if (change === "re-review") await f.decide(0, 0, "MAYBE");
    if (change === "capacity" || change === "finalized") {
      await f.decide(1, 0, "INCLUDE");
      await f.decide(2, 0, change === "capacity" ? "MAYBE" : "INCLUDE");
    }
    if (change === "quota")
      await quotas.saveQuotas(
        ownerCtx(f),
        f.guideline.id,
        { poolId: f.pool.id },
        { reviewers: [{ reviewerId: f.users[0]!.id, target: 0 }] },
      );
    if (change === "copy")
      await createTestCitation(f.groups[0]![0]!.projectId, {
        title: "New copy",
        doi: "10.6000/readiness-0",
      });
    if (change === "copy") {
      await expect(
        recovery.previewRestoration(ownerCtx(f), f.guideline.id, {
          withdrawalId: batch.withdrawalId,
          reason: "Restore batch",
        }),
      ).rejects.toMatchObject({ code: "INVALID_STATE" });
      return;
    }
    const p = await recovery.previewRestoration(ownerCtx(f), f.guideline.id, {
      withdrawalId: batch.withdrawalId,
      reason: "Restore batch",
    });
    expect(p.token).toBeNull();
    expect(p.summary.eligibleGroups).toBe(0);
    expect(
      await prisma.screeningWithdrawal.findUnique({
        where: { id: batch.withdrawalId },
      }),
    ).toMatchObject({ restoredAt: null });
  },
);

it("rejects expired plans and cross-guideline tokens", async () => {
  const f = await fixture(1);
  await f.decide(0, 0, "EXCLUDE");
  const p = await preview(f);
  const claims = JSON.parse(
    Buffer.from(p.token!.split(".")[0]!, "base64url").toString(),
  );
  await expect(
    recovery.executeRecovery(
      ownerCtx(f),
      f.guideline.id,
      signPlan({ ...claims, expiresAt: 1 }),
    ),
  ).rejects.toMatchObject({ code: "INVALID_STATE" });
  await expect(
    recovery.executeRecovery(ownerCtx(f), "another-guideline", p.token!),
  ).rejects.toMatchObject({ code: "FORBIDDEN" });
  expect((await rows(f)).every((d) => !d.withdrawnAt)).toBe(true);
});

it("rolls back decisions, assignments, conflicts, batch and audit if recording fails mid-operation", async () => {
  const f = await fixture(1);
  await f.decide(0, 0, "EXCLUDE");
  await f.decide(1, 0, "INCLUDE");
  const p = await preview(f);
  const before = await rows(f);
  const audits = await prisma.auditEvent.count();
  const original = audit.record;
  let n = 0;
  const spy = vi.spyOn(audit, "record").mockImplementation(async (...args) => {
    if (++n === 3) throw new Error("Injected local audit failure");
    return original(...args);
  });
  try {
    await expect(
      recovery.executeRecovery(ownerCtx(f), f.guideline.id, p.token!),
    ).rejects.toThrow("Injected local audit failure");
  } finally {
    spy.mockRestore();
  }
  expect(await rows(f)).toEqual(before);
  expect(await prisma.auditEvent.count()).toBe(audits);
  expect(
    await prisma.screeningWithdrawal.count({
      where: { guidelineId: f.guideline.id },
    }),
  ).toBe(0);
  expect(
    await prisma.screeningConflict.count({
      where: {
        citationId: { in: f.groups[0]!.map((c) => c.id) },
        status: "OPEN",
      },
    }),
  ).toBe(6);
  expect(
    await prisma.screeningAssignment.count({
      where: {
        citationId: { in: f.groups[0]!.map((c) => c.id) },
        status: "COMPLETED",
      },
    }),
  ).toBe(12);
});

it("concurrent duplicate execution creates one batch and one logical credit reversal", async () => {
  const f = await fixture(1);
  await f.decide(0, 0, "EXCLUDE");
  const p = await preview(f);
  const result = await Promise.all([
    recovery.executeRecovery(ownerCtx(f), f.guideline.id, p.token!),
    recovery.executeRecovery(ownerCtx(f), f.guideline.id, p.token!),
  ]);
  expect(result.filter((r) => r.replayed)).toHaveLength(1);
  expect(new Set(result.map((r) => r.withdrawalId)).size).toBe(1);
  expect(
    await prisma.screeningWithdrawal.count({
      where: { guidelineId: f.guideline.id },
    }),
  ).toBe(1);
  expect(
    await quotas.quotaProgress(prisma, { poolId: f.pool.id }, f.users[0]!.id),
  ).toMatchObject({ completed: 0, remaining: 10 });
});

it("holds prior consensus history after every linked result has been reopened", async () => {
  const f = await fixture(1);
  await f.decide(0, 0, "EXCLUDE");
  await f.decide(1, 0, "EXCLUDE");
  for (const c of f.groups[0]!)
    await screening.reopenCitation(ownerCtx(f), c.projectId, c.id, {
      stageType: "TITLE_ABSTRACT",
      reason: "Synthetic reopened consensus",
    });
  expect(
    await prisma.citationStageResult.count({
      where: { citationId: { in: f.groups[0]!.map((c) => c.id) } },
    }),
  ).toBe(0);
  const p = await preview(f);
  expect(p.token).toBeNull();
  expect(p.groups[0]!.reasons).toContain("FINALIZED_STAGE_HISTORY");
});

it("a fresh review reuses the decision key, clears inactivity, restores one logical credit, and keeps the original recovery snapshot", async () => {
  const f = await fixture(1);
  await f.decide(0, 0, "EXCLUDE", "Original exclusion");
  const before = await rows(f);
  const batch = await withdraw(f);
  await f.decide(0, 0, "INCLUDE", "Repeated using correct scope");
  const after = await rows(f);
  expect(after.map((d) => d.id)).toEqual(before.map((d) => d.id));
  expect(
    after.every(
      (d) => d.decision === "INCLUDE" && !d.withdrawnAt && !d.withdrawalId,
    ),
  ).toBe(true);
  expect(
    await quotas.quotaProgress(prisma, { poolId: f.pool.id }, f.users[0]!.id),
  ).toMatchObject({ completed: 1, remaining: 9 });
  expect((await f.queue(0, { status: "MY_REVIEWED" })).pagination.total).toBe(
    1,
  );
  const saved = await prisma.screeningWithdrawal.findUniqueOrThrow({
    where: { id: batch.withdrawalId },
  });
  expect(JSON.stringify(saved.manifest)).toContain("Original exclusion");
  expect(JSON.stringify(saved.manifest)).not.toContain(
    "Repeated using correct scope",
  );
});

it("a racing co-review and withdrawal serialize or reject stale state without losing either reviewer's history", async () => {
  const f = await fixture(1);
  await f.decide(0, 0, "EXCLUDE");
  const p = await preview(f);
  const result = await Promise.allSettled([
    recovery.executeRecovery(ownerCtx(f), f.guideline.id, p.token!),
    f.decide(1, 0, "INCLUDE"),
  ]);
  expect(result[1]!.status).toBe("fulfilled");
  const current = await rows(f);
  expect(
    current.filter(
      (d) =>
        d.reviewerId === f.users[1]!.id &&
        !d.withdrawnAt &&
        d.decision === "INCLUDE",
    ),
  ).toHaveLength(6);
  if (result[0]!.status === "rejected") {
    expect(result[0]!.reason.code).toBe("INVALID_STATE");
    expect(
      current.filter((d) => d.reviewerId === f.users[0]!.id && !d.withdrawnAt),
    ).toHaveLength(6);
  } else {
    expect(
      current.filter((d) => d.reviewerId === f.users[0]!.id && d.withdrawnAt),
    ).toHaveLength(6);
  }
});

it("restoration failure rolls back reactivation, assignments, conflict evaluation and audit; the same token can then safely retry", async () => {
  const f = await fixture(1);
  await f.decide(0, 0, "EXCLUDE");
  const batch = await withdraw(f);
  await f.decide(1, 0, "INCLUDE");
  const p = await recovery.previewRestoration(ownerCtx(f), f.guideline.id, {
    withdrawalId: batch.withdrawalId,
    reason: "Restore retained votes",
  });
  const before = await rows(f);
  const auditCount = await prisma.auditEvent.count();
  const original = audit.record;
  let calls = 0;
  const spy = vi.spyOn(audit, "record").mockImplementation(async (...args) => {
    if (++calls === 3) throw new Error("Injected restoration audit failure");
    return original(...args);
  });
  try {
    await expect(
      recovery.executeRecovery(ownerCtx(f), f.guideline.id, p.token!),
    ).rejects.toThrow("Injected restoration audit failure");
  } finally {
    spy.mockRestore();
  }
  expect(await rows(f)).toEqual(before);
  expect(await prisma.auditEvent.count()).toBe(auditCount);
  expect(
    await prisma.screeningConflict.count({
      where: {
        citationId: { in: f.groups[0]!.map((c) => c.id) },
        status: "OPEN",
      },
    }),
  ).toBe(0);
  expect(
    await prisma.screeningWithdrawal.findUnique({
      where: { id: batch.withdrawalId },
    }),
  ).toMatchObject({ restoredAt: null });
  await recovery.executeRecovery(ownerCtx(f), f.guideline.id, p.token!);
  expect(
    await prisma.screeningConflict.count({
      where: {
        citationId: { in: f.groups[0]!.map((c) => c.id) },
        status: "OPEN",
      },
    }),
  ).toBe(6);
});

it("a changed co-review invalidates a restoration preflight without reactivating retained votes", async () => {
  const f = await fixture(1);
  await f.decide(0, 0, "EXCLUDE");
  const batch = await withdraw(f);
  const p = await recovery.previewRestoration(ownerCtx(f), f.guideline.id, {
    withdrawalId: batch.withdrawalId,
    reason: "Restore retained votes",
  });
  await f.decide(1, 0, "MAYBE");
  const before = await rows(f);
  await expect(
    recovery.executeRecovery(ownerCtx(f), f.guideline.id, p.token!),
  ).rejects.toMatchObject({ code: "INVALID_STATE" });
  expect(await rows(f)).toEqual(before);
});

it.each(["actor-org", "target-org", "actor-pico"] as const)(
  "rejects execution after %s access removal",
  async (removed) => {
    const f = await fixture(1);
    await f.decide(0, 0, "EXCLUDE");
    const p = await preview(f);
    if (removed === "actor-pico")
      await prisma.projectMember.update({
        where: {
          projectId_userId: { projectId: f.picos[3]!.id, userId: f.owner.id },
        },
        data: { status: "REMOVED" },
      });
    else
      await prisma.organizationMember.update({
        where: {
          orgId_userId: {
            orgId: f.org.id,
            userId: removed === "actor-org" ? f.owner.id : f.users[0]!.id,
          },
        },
        data: { status: "REMOVED" },
      });
    await expect(
      recovery.executeRecovery(ownerCtx(f), f.guideline.id, p.token!),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect((await rows(f)).every((d) => !d.withdrawnAt)).toBe(true);
    expect(
      await prisma.screeningWithdrawal.count({
        where: { guidelineId: f.guideline.id },
      }),
    ).toBe(0);
  },
);

it("rejects incompatible Maybe evaluation settings across pooled stages", async () => {
  const f = await fixture(1);
  await f.decide(0, 0, "EXCLUDE");
  const stage = f.stages.find((s) => s.projectId === f.picos[2]!.id)!;
  await prisma.screeningStage.update({
    where: { id: stage.id },
    data: { maybeGeneratesConflict: !stage.maybeGeneratesConflict },
  });
  await expect(preview(f)).rejects.toMatchObject({ code: "INVALID_STATE" });
  expect((await rows(f)).every((d) => !d.withdrawnAt)).toBe(true);
});

it("holds differing active labels or discussion flags on linked copies", async () => {
  const f = await fixture(1);
  await f.decide(0, 0, "EXCLUDE");
  await prisma.screeningDecision.update({
    where: {
      stageId_citationId_reviewerId: {
        stageId: f.groups[0]![0]!.stageId,
        citationId: f.groups[0]![0]!.id,
        reviewerId: f.users[0]!.id,
      },
    },
    data: { labels: ["Differing label"], flaggedForDiscussion: true },
  });
  const p = await preview(f);
  expect(p.token).toBeNull();
  expect(p.groups[0]!.reasons).toContain("INCONSISTENT_LINKED_STATE");
});
