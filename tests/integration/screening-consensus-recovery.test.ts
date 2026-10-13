import { beforeAll, expect, it, vi } from "vitest";
import { prisma } from "@/server/db";
import * as recovery from "@/server/services/screening/withdrawal";
import * as screening from "@/server/services/screening";
import * as audit from "@/server/services/audit";
import { pooledReadinessFixture } from "../fixtures/pooled-readiness";
import { createTestCitation } from "../factories";
import { resetDb } from "../db-utils";

beforeAll(resetDb);
const clearance = {
  confirmed: true as const,
  reason:
    "Review lead confirmed no external exports, analyses or manuscript use",
};
async function fixture(count = 3) {
  const f = await pooledReadinessFixture({ count });
  const first = await prisma.citation.findUniqueOrThrow({
    where: { id: f.groups[0]![0]!.id },
  });
  for (const project of f.picos.slice(1)) {
    if (f.groups[0]!.some((c) => c.projectId === project.id)) continue;
    const copy = await createTestCitation(project.id, {
      title: first.title,
      doi: first.doi,
      pmid: first.pmid,
    });
    f.groups[0]!.push({
      id: copy.id,
      projectId: project.id,
      stageId: f.stages.find((s) => s.projectId === project.id)!.id,
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
  await f.decide(0, 0, "EXCLUDE", "Retained target note");
  await f.decide(1, 0, "EXCLUDE", "Private co-reviewer note");
  if (count > 1) await f.decide(0, 1, "INCLUDE");
  if (count > 2) await f.decide(0, 2, "MAYBE");
  return f;
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
const ctx = (f: Fixture) => ({ userId: f.owner.id });
const input = (f: Fixture) => ({
  poolId: f.pool.id,
  reviewerId: f.users[0]!.id,
  reason: "Repeat incorrect-scope exclusions",
  mode: "consensus" as const,
  externalUseClearance: clearance,
});
const preview = (f: Fixture) =>
  recovery.previewWithdrawal(ctx(f), f.guideline.id, input(f));
const ids = (f: Fixture) => f.groups[0]!.map((c) => c.id);
async function snapshot(f: Fixture) {
  const projectIds = [f.guideline.id, ...f.picos.map((p) => p.id)];
  return {
    decisions: await prisma.screeningDecision.findMany({
      where: { stage: { projectId: { in: projectIds } } },
      orderBy: { id: "asc" },
    }),
    assignments: await prisma.screeningAssignment.findMany({
      where: { stage: { projectId: { in: projectIds } } },
      orderBy: { id: "asc" },
    }),
    results: await prisma.citationStageResult.findMany({
      where: { stage: { projectId: { in: projectIds } } },
      orderBy: { id: "asc" },
    }),
    audits: await prisma.auditEvent.findMany({
      where: { projectId: { in: projectIds } },
      orderBy: { id: "asc" },
    }),
    batches: await prisma.screeningWithdrawal.findMany({
      where: { guidelineId: f.guideline.id },
      orderBy: { id: "asc" },
    }),
  };
}
async function withdraw(f: Fixture) {
  const p = await preview(f);
  expect(p.token).toBeTruthy();
  return {
    p,
    result: await recovery.executeRecovery(ctx(f), f.guideline.id, p.token!),
  };
}
const restore = (f: Fixture, withdrawalId: string) =>
  recovery.previewRestoration(ctx(f), f.guideline.id, {
    withdrawalId,
    reason: "Restore unchanged reviewed batch",
    externalUseClearance: clearance,
  });

it("explicit consensus recovery preflights six linked copies and preserves default historical holds", async () => {
  const f = await fixture();
  const ordinary = await recovery.previewWithdrawal(ctx(f), f.guideline.id, {
    poolId: f.pool.id,
    reviewerId: f.users[0]!.id,
    reason: "Ordinary recovery",
  });
  expect(ordinary.summary.eligibleGroups).toBe(0);
  const p = await preview(f);
  expect(p.summary).toMatchObject({
    selectedGroups: 1,
    eligibleGroups: 1,
    heldGroups: 0,
    linkedDecisions: 6,
  });
  expect(JSON.stringify(p)).not.toContain("Private co-reviewer note");
  expect(JSON.stringify(p)).not.toContain("coReviewerFingerprint");
  expect(p.summary.finalizedResultsToReopen).toBe(6);
});

it("atomically withdraws only Exclude votes, reopens dependent results, preserves snapshots and other work, retries and restores", async () => {
  const f = await fixture();
  const solo = await createTestCitation(f.picos[0]!.id);
  const soloStage = f.stages.find((s) => s.projectId === solo.projectId)!;
  await prisma.screeningAssignment.create({
    data: {
      stageId: soloStage.id,
      citationId: solo.id,
      reviewerId: f.users[0]!.id,
    },
  });
  await screening.createDecision(
    { userId: f.users[0]!.id },
    solo.projectId,
    soloStage.id,
    { citationId: solo.id, decision: "EXCLUDE" },
  );
  const before = await snapshot(f),
    p = await preview(f);
  expect(await snapshot(f)).toEqual(before);
  const result = await recovery.executeRecovery(
    ctx(f),
    f.guideline.id,
    p.token!,
  );
  const after = await snapshot(f);
  expect(result.summary).toMatchObject({
    eligibleGroups: 1,
    linkedDecisions: 6,
    completedBefore: 3,
    completedAfter: 2,
    remainingAfter: 8,
    finalizedResultsToReopen: 6,
  });
  for (const old of before.decisions) {
    const current = after.decisions.find((d) => d.id === old.id)!;
    if (old.reviewerId === f.users[0]!.id && ids(f).includes(old.citationId))
      expect(current).toMatchObject({
        ...old,
        withdrawnAt: expect.any(Date),
        withdrawalId: result.withdrawalId,
        updatedAt: expect.any(Date),
      });
    else expect(current).toEqual(old);
  }
  for (const old of before.assignments) {
    const current = after.assignments.find((a) => a.id === old.id)!;
    if (old.reviewerId === f.users[0]!.id && ids(f).includes(old.citationId))
      expect(current).toMatchObject({
        ...old,
        status: "PENDING",
        updatedAt: expect.any(Date),
      });
    else expect(current).toEqual(old);
  }
  expect(after.results.filter((r) => ids(f).includes(r.citationId))).toEqual(
    [],
  );
  expect(
    after.audits.filter((a) => a.action === "screening.result.reopened"),
  ).toHaveLength(6);
  for (const old of before.audits)
    expect(after.audits.find((a) => a.id === old.id)).toEqual(old);
  const batch = after.batches[0]!,
    manifest = batch.manifest as any;
  expect(manifest).toMatchObject({
    version: 2,
    mode: "consensus",
    externalUseClearance: clearance,
  });
  expect(manifest.groups[0].consensus.results).toHaveLength(6);
  for (const r of before.results.filter((r) => ids(f).includes(r.citationId)))
    expect(
      manifest.groups[0].consensus.results.find((s: any) => s.id === r.id),
    ).toMatchObject({ ...r, resolvedAt: r.resolvedAt.toISOString() });
  expect(JSON.stringify(manifest)).not.toContain("Private co-reviewer note");
  const queue = await f.queue();
  expect(queue.items.find((c) => ids(f).includes(c.id))).toBeDefined();
  expect(
    await recovery.executeRecovery(ctx(f), f.guideline.id, p.token!),
  ).toMatchObject({ replayed: true, withdrawalId: result.withdrawalId });
  expect(await snapshot(f)).toEqual(after);
  await expect(
    recovery.previewRestoration(ctx(f), f.guideline.id, {
      withdrawalId: result.withdrawalId,
      reason: "Clearance unanswered",
    }),
  ).rejects.toThrow(/clearance/i);
  const rp = await restore(f, result.withdrawalId);
  expect(rp.groups.map((g) => g.reasons)).toEqual([[]]);
  expect(rp.summary.eligibleGroups).toBe(1);
  const restored = await recovery.executeRecovery(
    ctx(f),
    f.guideline.id,
    rp.token!,
  );
  expect(restored.summary).toMatchObject({
    completedAfter: 3,
    remainingAfter: 7,
  });
  const final = await snapshot(f);
  expect(
    final.results.filter((r) => ids(f).includes(r.citationId)),
  ).toHaveLength(6);
  for (const old of before.decisions)
    expect(final.decisions.find((d) => d.id === old.id)).toMatchObject({
      ...old,
      updatedAt:
        old.reviewerId === f.users[0]!.id && ids(f).includes(old.citationId)
          ? expect.any(Date)
          : old.updatedAt,
    });
  expect(
    await recovery.executeRecovery(ctx(f), f.guideline.id, rp.token!),
  ).toMatchObject({ replayed: true });
  await expect(
    recovery.executeRecovery(ctx(f), f.guideline.id, p.token!),
  ).rejects.toMatchObject({ code: "INVALID_STATE" });
});

it("requires explicit external-use clearance and refuses ordinary mode for consensus history", async () => {
  const f = await fixture(1),
    before = await snapshot(f);
  for (const externalUseClearance of [
    undefined,
    { confirmed: false, reason: "Unknown" },
    { confirmed: true, reason: "" },
  ])
    await expect(
      recovery.previewWithdrawal(ctx(f), f.guideline.id, {
        ...input(f),
        externalUseClearance,
      } as any),
    ).rejects.toThrow();
  expect(await snapshot(f)).toEqual(before);
});

it.each(["REVIEWER", "ADJUDICATOR", "LIBRARIAN", "OBSERVER"] as const)(
  "rejects consensus mode for %s",
  async (role) => {
    const f = await fixture(1),
      before = await snapshot(f);
    await prisma.projectMember.update({
      where: {
        projectId_userId: { projectId: f.guideline.id, userId: f.users[2]!.id },
      },
      data: { roles: [role] },
    });
    await expect(
      recovery.previewWithdrawal(
        { userId: f.users[2]!.id },
        f.guideline.id,
        input(f),
      ),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect((await snapshot(f)).decisions).toEqual(before.decisions);
  },
);

it.each([
  "missing-audit",
  "extra-history",
  "wrong-entity",
  "wrong-action",
  "wrong-actor",
  "previous-value",
  "include-result",
  "wrong-result-time",
  "adjudicated-result",
  "resolved-conflict",
  "single-reviewer",
] as const)("holds unverified provenance: %s", async (change) => {
  const f = await fixture(1),
    copy = f.groups[0]![0]!;
  const result = await prisma.citationStageResult.findUniqueOrThrow({
    where: {
      stageId_citationId: { stageId: copy.stageId, citationId: copy.id },
    },
  });
  const event = await prisma.auditEvent.findFirstOrThrow({
    where: { entityId: result.id, entityType: "CitationStageResult" },
  });
  if (change === "missing-audit")
    await prisma.auditEvent.delete({ where: { id: event.id } });
  if (change === "extra-history")
    await prisma.auditEvent.create({
      data: {
        projectId: copy.projectId,
        userId: f.owner.id,
        entityType: "CitationStageResult",
        entityId: "historical-adjudication",
        action: "screening.result.created",
        newValue: {
          stageId: copy.stageId,
          citationId: copy.id,
          outcome: "EXCLUDE",
          resolvedVia: "ADJUDICATION",
        },
      },
    });
  if (change === "wrong-entity")
    await prisma.auditEvent.update({
      where: { id: event.id },
      data: { entityId: "other-result" },
    });
  if (change === "wrong-action")
    await prisma.auditEvent.update({
      where: { id: event.id },
      data: { action: "screening.result.reopened" },
    });
  if (change === "wrong-actor")
    await prisma.auditEvent.update({
      where: { id: event.id },
      data: { userId: f.owner.id },
    });
  if (change === "previous-value")
    await prisma.auditEvent.update({
      where: { id: event.id },
      data: { previousValue: { resolvedVia: "ADJUDICATION" } },
    });
  if (change === "include-result")
    await prisma.citationStageResult.update({
      where: { id: result.id },
      data: { outcome: "INCLUDE" },
    });
  if (change === "wrong-result-time")
    await prisma.citationStageResult.update({
      where: { id: result.id },
      data: { resolvedAt: new Date(event.createdAt.getTime() + 60_000) },
    });
  if (change === "adjudicated-result")
    await prisma.citationStageResult.update({
      where: { id: result.id },
      data: { resolvedVia: "ADJUDICATION" },
    });
  if (change === "resolved-conflict")
    await prisma.screeningConflict.create({
      data: {
        citationId: copy.id,
        stageId: copy.stageId,
        status: "RESOLVED",
        adjudication: {
          create: {
            adjudicatorId: f.owner.id,
            finalDecision: "EXCLUDE",
            reason: "Human judgment",
          },
        },
      },
    });
  if (change === "single-reviewer")
    await prisma.screeningStage.updateMany({
      where: {
        projectId: { in: f.picos.slice(1).map((p) => p.id) },
        type: "TITLE_ABSTRACT",
      },
      data: { reviewersPerCitation: 1 },
    });
  const before = await snapshot(f),
    p = await preview(f);
  expect(p.token).toBeNull();
  expect(p.groups[0]!.reasons).toContain("CONSENSUS_PROVENANCE_UNVERIFIED");
  expect(await snapshot(f)).toEqual(before);
});

it.each(["assignment", "decision", "result", "study", "retrieval"] as const)(
  "holds concrete downstream %s",
  async (dependency) => {
    const f = await fixture(1),
      copy = f.groups[0]![0]!;
    const ft = await prisma.screeningStage.findFirstOrThrow({
      where: { projectId: copy.projectId, type: "FULL_TEXT" },
    });
    if (dependency === "assignment")
      await prisma.screeningAssignment.create({
        data: {
          stageId: ft.id,
          citationId: copy.id,
          reviewerId: f.users[0]!.id,
        },
      });
    if (dependency === "decision")
      await prisma.screeningDecision.create({
        data: {
          stageId: ft.id,
          citationId: copy.id,
          reviewerId: f.users[0]!.id,
          decision: "EXCLUDE",
        },
      });
    if (dependency === "result")
      await prisma.citationStageResult.create({
        data: {
          stageId: ft.id,
          citationId: copy.id,
          outcome: "INCLUDE",
          resolvedVia: "CONSENSUS",
        },
      });
    if (dependency === "study")
      await prisma.study.create({
        data: {
          projectId: copy.projectId,
          label: "Downstream study",
          createdById: f.owner.id,
          reportLinks: { create: { citationId: copy.id } },
        },
      });
    if (dependency === "retrieval")
      await prisma.fullTextRetrievalAttempt.create({
        data: {
          citationId: copy.id,
          method: "Synthetic retrieval",
          outcome: "PENDING",
          recordedById: f.owner.id,
        },
      });
    const before = await snapshot(f),
      p = await preview(f);
    expect(p.token).toBeNull();
    expect(p.groups[0]!.reasons).toContain("DOWNSTREAM_HISTORY");
    expect(await snapshot(f)).toEqual(before);
  },
);

it.each([
  "co-review",
  "result-time",
  "new-copy",
  "history",
  "quota",
  "role",
] as const)("rejects stale consensus plan after %s", async (change) => {
  const f = await fixture(1),
    p = await preview(f),
    copy = f.groups[0]![0]!;
  if (change === "co-review")
    await prisma.screeningDecision.updateMany({
      where: { citationId: { in: ids(f) }, reviewerId: f.users[1]!.id },
      data: { notes: "Changed retained review" },
    });
  if (change === "result-time")
    await prisma.citationStageResult.updateMany({
      where: { citationId: { in: ids(f) } },
      data: { resolvedAt: new Date(0) },
    });
  if (change === "new-copy")
    await createTestCitation(copy.projectId, { doi: "10.6000/readiness-0" });
  if (change === "history")
    await prisma.auditEvent.updateMany({
      where: { entityType: "CitationStageResult", projectId: copy.projectId },
      data: { reason: "Changed result provenance" },
    });
  if (change === "quota")
    await prisma.screeningQuota.updateMany({
      where: { poolId: f.pool.id, reviewerId: f.users[0]!.id },
      data: { target: 20 },
    });
  if (change === "role")
    await prisma.projectMember.update({
      where: {
        projectId_userId: { projectId: f.picos[3]!.id, userId: f.users[0]!.id },
      },
      data: { status: "REMOVED" },
    });
  const before = await snapshot(f);
  await expect(
    recovery.executeRecovery(ctx(f), f.guideline.id, p.token!),
  ).rejects.toMatchObject({
    code: change === "role" ? "FORBIDDEN" : "INVALID_STATE",
  });
  expect(await snapshot(f)).toEqual(before);
});

it("rolls back result invalidation, votes, assignments, ledger and audits on failure, then safely retries", async () => {
  const f = await fixture(1),
    p = await preview(f),
    before = await snapshot(f),
    original = audit.record;
  let calls = 0;
  const spy = vi.spyOn(audit, "record").mockImplementation(async (...args) => {
    if (++calls === 5) throw new Error("Injected recovery failure");
    return original(...args);
  });
  try {
    await expect(
      recovery.executeRecovery(ctx(f), f.guideline.id, p.token!),
    ).rejects.toThrow("Injected recovery failure");
  } finally {
    spy.mockRestore();
  }
  expect(await snapshot(f)).toEqual(before);
  await recovery.executeRecovery(ctx(f), f.guideline.id, p.token!);
  expect((await snapshot(f)).results).toEqual([]);
});

it.each([
  "replacement-review",
  "target-rereview",
  "co-review-change",
  "assignment-replaced",
  "new-history",
  "downstream",
  "quota",
] as const)("holds whole consensus restoration after %s", async (change) => {
  const f = await fixture(2);
  await f.decide(0, 1, "EXCLUDE");
  await f.decide(1, 1, "EXCLUDE");
  const { result } = await withdraw(f),
    copy = f.groups[1]![0]!;
  if (change === "replacement-review") await f.decide(2, 1, "EXCLUDE");
  if (change === "target-rereview") await f.decide(0, 1, "MAYBE");
  if (change === "co-review-change")
    await f.decide(1, 1, "EXCLUDE", "Changed other review note");
  if (change === "assignment-replaced") {
    const a = await prisma.screeningAssignment.findFirstOrThrow({
      where: { citationId: copy.id, reviewerId: f.users[0]!.id },
    });
    await prisma.screeningAssignment.delete({ where: { id: a.id } });
    await prisma.screeningAssignment.create({
      data: {
        stageId: a.stageId,
        citationId: a.citationId,
        reviewerId: a.reviewerId,
      },
    });
  }
  if (change === "new-history")
    await prisma.auditEvent.create({
      data: {
        projectId: copy.projectId,
        userId: f.owner.id,
        entityType: "CitationStageResult",
        entityId: "additional-history",
        action: "screening.result.reopened",
        previousValue: {
          stageId: copy.stageId,
          citationId: copy.id,
          outcome: "EXCLUDE",
          resolvedVia: "CONSENSUS",
        },
      },
    });
  if (change === "downstream")
    await prisma.fullTextRetrievalAttempt.create({
      data: {
        citationId: copy.id,
        method: "Synthetic retrieval",
        outcome: "PENDING",
        recordedById: f.owner.id,
      },
    });
  if (change === "quota")
    await prisma.screeningQuota.updateMany({
      where: { poolId: f.pool.id, reviewerId: f.users[0]!.id },
      data: { target: 0 },
    });
  const before = await snapshot(f),
    p = await restore(f, result.withdrawalId);
  expect(p.token).toBeNull();
  expect(p.summary).toMatchObject({ eligibleGroups: 0, heldGroups: 2 });
  expect(await snapshot(f)).toEqual(before);
});

it("rolls back consensus restoration and newly derived results if its audit fails", async () => {
  const f = await fixture(1),
    { result } = await withdraw(f),
    p = await restore(f, result.withdrawalId),
    before = await snapshot(f),
    original = audit.record;
  let calls = 0;
  const spy = vi.spyOn(audit, "record").mockImplementation(async (...args) => {
    if (++calls === 3) throw new Error("Injected restoration failure");
    return original(...args);
  });
  try {
    await expect(
      recovery.executeRecovery(ctx(f), f.guideline.id, p.token!),
    ).rejects.toThrow("Injected restoration failure");
  } finally {
    spy.mockRestore();
  }
  expect(await snapshot(f)).toEqual(before);
  await recovery.executeRecovery(ctx(f), f.guideline.id, p.token!);
  expect((await snapshot(f)).results).toHaveLength(6);
});

it("serializes an ordinary reopen racing the consensus withdrawal without losing history", async () => {
  const f = await fixture(1),
    p = await preview(f),
    copy = f.groups[0]![0]!;
  const results = await Promise.allSettled([
    recovery.executeRecovery(ctx(f), f.guideline.id, p.token!),
    screening.reopenCitation(ctx(f), copy.projectId, copy.id, {
      stageType: "TITLE_ABSTRACT",
      reason: "Racing explicit reopen",
    }),
  ]);
  expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
  const state = await snapshot(f),
    withdrawn = state.decisions.filter(
      (d) => d.reviewerId === f.users[0]!.id && d.withdrawnAt,
    );
  expect([0, 6]).toContain(withdrawn.length);
  expect(
    state.decisions.filter(
      (d) => d.reviewerId === f.users[1]!.id && !d.withdrawnAt,
    ),
  ).toHaveLength(6);
  for (const result of results)
    if (result.status === "rejected")
      expect(result.reason.code).toBe("INVALID_STATE");
});
