import { afterEach, beforeAll, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { prisma } from "@/server/db";
import * as audit from "@/server/services/audit";
import * as screening from "@/server/services/screening";
import * as citations from "@/server/services/citations";
import * as protocols from "@/server/services/protocols";
import * as adjudication from "@/server/services/screening/pooled-adjudication";
import { resetDb } from "../db-utils";
import { pooledReadinessFixture } from "../fixtures/pooled-readiness";
import { createTestUser } from "../factories";

// Refuse even the suite's local truncation unless the target is explicitly a local test DB.
// The integration runner's global setup runs earlier, so verify the URL before invoking it too.
beforeAll(async () => {
  const url = new URL(process.env.TEST_DATABASE_URL ?? "");
  if (
    !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) ||
    !/(^|[_-])test([_-]|$)/i.test(url.pathname.slice(1))
  ) {
    throw new Error(
      "Pooled adjudication tests require a local, test-named database",
    );
  }
  await resetDb();
});
afterEach(() => vi.restoreAllMocks());

type Fixture = Awaited<ReturnType<typeof pooledReadinessFixture>>;
const citationIds = (f: Fixture) => f.groups[0]!.map((copy) => copy.id);
const ctx = (f: Fixture) => ({ userId: f.owner.id });
async function fixture() {
  const f = await pooledReadinessFixture({ count: 1, reviewers: 2 });
  await f.decide(0, 0, "INCLUDE", "Reviewer one rationale");
  await f.decide(1, 0, "EXCLUDE", "Reviewer two rationale");
  return f;
}
async function item(f: Fixture) {
  const list = await adjudication.listPooledConflicts(ctx(f), f.guideline.id, {
    poolId: f.pool.id,
  });
  const found = list.items.find((row) =>
    row.citationIds.includes(citationIds(f)[0]!),
  );
  expect(found).toBeDefined();
  return found!;
}
async function input(f: Fixture) {
  const row = await item(f);
  return {
    poolId: f.pool.id,
    citationIds: row.citationIds,
    stateToken: row.stateToken,
    finalDecision: "INCLUDE" as const,
    reason: "Adjudicator reviewed both rationales",
  };
}
async function snapshot(f: Fixture) {
  const where = { citationId: { in: citationIds(f) } };
  return {
    quotas: await prisma.screeningQuota.findMany({
      where: { poolId: f.pool.id },
      orderBy: { id: "asc" },
    }),
    votes: await prisma.screeningDecision.findMany({
      where,
      orderBy: { id: "asc" },
    }),
    assignments: await prisma.screeningAssignment.findMany({
      where,
      orderBy: { id: "asc" },
    }),
    conflicts: await prisma.screeningConflict.findMany({
      where,
      include: { adjudication: true },
      orderBy: { id: "asc" },
    }),
    results: await prisma.citationStageResult.findMany({
      where,
      orderBy: { id: "asc" },
    }),
    audits: await prisma.auditEvent.findMany({
      where: { projectId: { in: f.picos.map((p) => p.id) } },
      orderBy: { id: "asc" },
    }),
  };
}

it.each(["INCLUDE", "EXCLUDE"] as const)(
  "adjudicates %s on every copy without changing reviewer votes, assignments, or quota credit",
  async (finalDecision) => {
    const f = await fixture();
    const before = await snapshot(f);
    const quotaBefore = await Promise.all(
      f.users.map((_, i) => f.queue(i).then((q) => q.quota)),
    );
    const row = await item(f);
    expect(row.status).toBe("OPEN");
    expect([...row.citationIds].sort()).toEqual(citationIds(f).sort());
    await adjudication.adjudicatePooledConflict(ctx(f), f.guideline.id, {
      ...(await input(f)),
      finalDecision,
      ...(finalDecision === "EXCLUDE"
        ? { exclusionReasonLabel: "Wrong population" }
        : {}),
    });
    const after = await snapshot(f);
    expect(after.quotas).toEqual(before.quotas);
    expect(after.votes).toEqual(before.votes);
    expect(after.assignments).toEqual(before.assignments);
    expect(after.results).toHaveLength(3);
    expect(
      after.results.every(
        (r) => r.outcome === finalDecision && r.resolvedVia === "ADJUDICATION",
      ),
    ).toBe(true);
    expect(
      after.conflicts.every(
        (c) =>
          c.status === "RESOLVED" &&
          c.adjudication?.finalDecision === finalDecision &&
          c.adjudication.adjudicatorId === f.owner.id,
      ),
    ).toBe(true);
    if (finalDecision === "EXCLUDE") {
      const rows = await prisma.screeningAdjudication.findMany({
        where: { conflictId: { in: after.conflicts.map((c) => c.id) } },
        include: {
          exclusionReason: true,
          conflict: { include: { stage: true } },
        },
      });
      expect(
        rows.every(
          (r) =>
            r.exclusionReason?.label === "Wrong population" &&
            r.exclusionReason.projectId === r.conflict.stage.projectId,
        ),
      ).toBe(true);
    }
    expect(
      await Promise.all(f.users.map((_, i) => f.queue(i).then((q) => q.quota))),
    ).toEqual(quotaBefore);
    expect((await item(f)).status).toBe("RESOLVED");
    expect(after.audits.length).toBeGreaterThan(before.audits.length);
  },
);

it("denies blinded reviewers and outsiders without exposing conflicts or changing state", async () => {
  const f = await fixture();
  const outsider = await createTestUser();
  const request = await input(f);
  const before = await snapshot(f);
  for (const userId of [f.users[0]!.id, outsider.id]) {
    await expect(
      adjudication.listPooledConflicts({ userId }, f.guideline.id, {
        poolId: f.pool.id,
      }),
    ).rejects.toThrow();
    await expect(
      adjudication.adjudicatePooledConflict(
        { userId },
        f.guideline.id,
        request,
      ),
    ).rejects.toThrow();
  }
  expect(await snapshot(f)).toEqual(before);
});

it("rejects an incomplete copy selection atomically", async () => {
  const f = await fixture();
  const request = await input(f);
  const before = await snapshot(f);
  await expect(
    adjudication.adjudicatePooledConflict(ctx(f), f.guideline.id, {
      ...request,
      citationIds: request.citationIds.slice(1),
    }),
  ).rejects.toThrow();
  expect(await snapshot(f)).toEqual(before);
});

it("invalidates a stale token after a synchronized reviewer revision", async () => {
  const f = await fixture();
  const request = await input(f);
  await f.decide(0, 0, "INCLUDE", "Revised evidence assessment");
  const before = await snapshot(f);
  expect((await item(f)).stateToken).not.toBe(request.stateToken);
  await expect(
    adjudication.adjudicatePooledConflict(ctx(f), f.guideline.id, request),
  ).rejects.toThrow();
  expect(await snapshot(f)).toEqual(before);
});

it("rejects historical partial adjudication without silently migrating it", async () => {
  const f = await fixture();
  const request = await input(f);
  const copy = f.groups[0]![0]!;
  const conflict = await prisma.screeningConflict.findUniqueOrThrow({
    where: {
      stageId_citationId: { stageId: copy.stageId, citationId: copy.id },
    },
  });
  await prisma.screeningAdjudication.create({
    data: {
      conflictId: conflict.id,
      adjudicatorId: f.owner.id,
      finalDecision: "EXCLUDE",
      reason: "Historical individual decision",
    },
  });
  await prisma.screeningConflict.update({
    where: { id: conflict.id },
    data: { status: "RESOLVED", resolvedAt: new Date() },
  });
  await prisma.citationStageResult.create({
    data: {
      stageId: copy.stageId,
      citationId: copy.id,
      outcome: "EXCLUDE",
      resolvedVia: "ADJUDICATION",
    },
  });
  const before = await snapshot(f);
  const row = await item(f);
  expect(row.status).toBe("NEEDS_SYNCHRONIZATION");
  expect(row.historicalAdjudications).toEqual([
    expect.objectContaining({
      projectId: copy.projectId,
      citationId: copy.id,
      conflictStatus: "RESOLVED",
      adjudication: expect.objectContaining({
        reason: "Historical individual decision",
        finalDecision: "EXCLUDE",
        adjudicatorId: f.owner.id,
      }),
    }),
  ]);
  await expect(
    adjudication.adjudicatePooledConflict(ctx(f), f.guideline.id, {
      ...request,
      stateToken: row.stateToken,
    }),
  ).rejects.toThrow();
  await expect(
    adjudication.reopenPooledConflict(ctx(f), f.guideline.id, {
      ...request,
      stateToken: row.stateToken,
    }),
  ).rejects.toThrow();
  expect(await snapshot(f)).toEqual(before);
});

it("rejects individual adjudication and individual reopening for pooled title/abstract copies", async () => {
  const f = await fixture();
  const copy = f.groups[0]![0]!;
  const before = await snapshot(f);
  const conflict = before.conflicts.find((c) => c.citationId === copy.id)!;
  await expect(
    screening.adjudicateConflict(ctx(f), copy.projectId, conflict.id, {
      finalDecision: "INCLUDE",
      reason: "Attempt per-PICO decision",
    }),
  ).rejects.toThrow();
  expect(await snapshot(f)).toEqual(before);
  await adjudication.adjudicatePooledConflict(
    ctx(f),
    f.guideline.id,
    await input(f),
  );
  const resolved = await snapshot(f);
  await expect(
    screening.reopenCitation(ctx(f), copy.projectId, copy.id, {
      stageType: "TITLE_ABSTRACT",
      reason: "Attempt per-PICO reopen",
    }),
  ).rejects.toThrow();
  expect(await snapshot(f)).toEqual(resolved);
});

it("reopens all copies together, preserves votes and credit, and permits a new pooled adjudication", async () => {
  const f = await fixture();
  await adjudication.adjudicatePooledConflict(
    ctx(f),
    f.guideline.id,
    await input(f),
  );
  const before = await snapshot(f);
  const request = await input(f);
  await expect(
    adjudication.reopenPooledConflict(
      { userId: f.users[0]!.id },
      f.guideline.id,
      request,
    ),
  ).rejects.toThrow();
  await adjudication.reopenPooledConflict(ctx(f), f.guideline.id, {
    ...request,
    reason: "Reconsider with corrected protocol",
  });
  const reopened = await snapshot(f);
  expect(reopened.results).toHaveLength(0);
  expect(reopened.conflicts.every((c) => c.status === "VOIDED")).toBe(true);
  expect(reopened.votes).toEqual(before.votes);
  expect(reopened.assignments).toEqual(before.assignments);
  await f.decide(0, 0, "INCLUDE", "Reviewed again after reopening");
  expect((await item(f)).status).toBe("OPEN");
  await expect(
    adjudication.reopenPooledConflict(ctx(f), f.guideline.id, request),
  ).rejects.toThrow();
  await adjudication.adjudicatePooledConflict(ctx(f), f.guideline.id, {
    ...(await input(f)),
    finalDecision: "EXCLUDE",
    exclusionReasonLabel: "Wrong population",
  });
  const final = await snapshot(f);
  expect(final.conflicts.map((c) => c.adjudication?.id)).toEqual(
    before.conflicts.map((c) => c.adjudication?.id),
  );
  expect(final.results.every((r) => r.outcome === "EXCLUDE")).toBe(true);
});

it("rolls back every copy and audit if a later audit write fails", async () => {
  const f = await fixture();
  const request = await input(f);
  const before = await snapshot(f);
  const original = audit.record;
  let calls = 0;
  vi.spyOn(audit, "record").mockImplementation(async (...args) => {
    if (++calls === 2) throw new Error("Injected pooled audit failure");
    return original(...args);
  });
  await expect(
    adjudication.adjudicatePooledConflict(ctx(f), f.guideline.id, request),
  ).rejects.toThrow("Injected pooled audit failure");
  expect(calls).toBe(2);
  expect(await snapshot(f)).toEqual(before);
});

it("allows only one concurrent adjudicator to commit the same state token", async () => {
  const f = await fixture();
  const other = await createTestUser();
  await prisma.organizationMember.create({
    data: { orgId: f.org.id, userId: other.id, role: "MEMBER" },
  });
  await prisma.projectMember.create({
    data: {
      projectId: f.guideline.id,
      userId: other.id,
      roles: ["ADJUDICATOR"],
    },
  });
  await prisma.projectMember.createMany({
    data: f.picos.slice(1).map((p) => ({
      projectId: p.id,
      userId: other.id,
      roles: ["ADJUDICATOR" as const],
    })),
  });
  const request = await input(f);
  const results = await Promise.allSettled([
    adjudication.adjudicatePooledConflict(ctx(f), f.guideline.id, request),
    adjudication.adjudicatePooledConflict(
      { userId: other.id },
      f.guideline.id,
      {
        ...request,
        finalDecision: "EXCLUDE",
        exclusionReasonLabel: "Wrong population",
      },
    ),
  ]);
  expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
  expect(results.filter((r) => r.status === "rejected")).toHaveLength(1);
  const final = await snapshot(f);
  expect(final.results).toHaveLength(3);
  expect(new Set(final.results.map((r) => r.outcome)).size).toBe(1);
  expect(
    new Set(final.conflicts.map((c) => c.adjudication?.adjudicatorId)).size,
  ).toBe(1);
  expect(final.conflicts.every((c) => c.status === "RESOLVED")).toBe(true);
});

it.each(["standalone title/abstract", "pooled full-text"] as const)(
  "preserves individual adjudication and reopen for %s",
  async (scenario) => {
    const f = await pooledReadinessFixture({ count: 1, reviewers: 2 });
    const pooledCopy = f.groups[0]![0]!;
    const projectId =
      scenario === "pooled full-text" ? pooledCopy.projectId : f.picos[0]!.id;
    const stageType =
      scenario === "pooled full-text"
        ? ("FULL_TEXT" as const)
        : ("TITLE_ABSTRACT" as const);
    const stage = await prisma.screeningStage.findUniqueOrThrow({
      where: { projectId_type: { projectId, type: stageType } },
    });
    const citation =
      scenario === "pooled full-text"
        ? pooledCopy
        : await prisma.citation.create({
            data: {
              projectId,
              title: "Standalone citation",
              normalizedTitle: "standalone citation",
              authors: [],
            },
          });
    if (stageType === "FULL_TEXT") {
      await prisma.citationStageResult.create({
        data: {
          stageId: pooledCopy.stageId,
          citationId: citation.id,
          outcome: "INCLUDE",
          resolvedVia: "CONSENSUS",
        },
      });
    }
    const conflict = await prisma.screeningConflict.create({
      data: { stageId: stage.id, citationId: citation.id },
    });
    await screening.adjudicateConflict(ctx(f), projectId, conflict.id, {
      finalDecision: "INCLUDE",
      reason: "Ordinary individual adjudication",
    });
    expect(
      await prisma.citationStageResult.findUnique({
        where: {
          stageId_citationId: { stageId: stage.id, citationId: citation.id },
        },
      }),
    ).toMatchObject({ outcome: "INCLUDE", resolvedVia: "ADJUDICATION" });
    await screening.reopenCitation(ctx(f), projectId, citation.id, {
      stageType,
      reason: "Ordinary individual reopen",
    });
    expect(
      await prisma.citationStageResult.findUnique({
        where: {
          stageId_citationId: { stageId: stage.id, citationId: citation.id },
        },
      }),
    ).toBeNull();
    expect(
      await prisma.screeningConflict.findUnique({ where: { id: conflict.id } }),
    ).toMatchObject({ status: "VOIDED" });
  },
);

it.each(["doi", "pmid"] as const)(
  "blocks identity groups with inconsistent %s values even when all reviews agree across copies",
  async (field) => {
    const f = await fixture();
    await prisma.citation.update({
      where: { id: citationIds(f)[0]! },
      data: {
        [field]: field === "doi" ? "10.6000/different-study" : "99999999",
      },
    });
    const before = await snapshot(f);
    const row = await item(f);
    expect(row.status).toBe("NEEDS_SYNCHRONIZATION");
    await expect(
      adjudication.adjudicatePooledConflict(
        ctx(f),
        f.guideline.id,
        await input(f),
      ),
    ).rejects.toThrow();
    expect(await snapshot(f)).toEqual(before);
  },
);

it("blocks a same-PICO duplicate in an otherwise synchronized identity group", async () => {
  const f = await fixture();
  const copy = f.groups[0]![0]!;
  const source = await prisma.citation.findUniqueOrThrow({
    where: { id: copy.id },
  });
  const duplicate = await prisma.citation.create({
    data: {
      projectId: copy.projectId,
      title: source.title,
      normalizedTitle: source.normalizedTitle,
      doi: source.doi,
      pmid: source.pmid,
      authors: [],
    },
  });
  const sourceVotes = await prisma.screeningDecision.findMany({
    where: { citationId: copy.id },
  });
  for (const vote of sourceVotes) {
    await prisma.screeningAssignment.create({
      data: {
        citationId: duplicate.id,
        stageId: copy.stageId,
        reviewerId: vote.reviewerId,
        status: "COMPLETED",
      },
    });
    await prisma.screeningDecision.create({
      data: {
        citationId: duplicate.id,
        stageId: copy.stageId,
        reviewerId: vote.reviewerId,
        decision: vote.decision,
        exclusionReasonId: vote.exclusionReasonId,
        notes: vote.notes,
        labels: vote.labels,
      },
    });
  }
  await prisma.screeningConflict.create({
    data: { citationId: duplicate.id, stageId: copy.stageId },
  });
  f.groups[0]!.push({
    id: duplicate.id,
    projectId: copy.projectId,
    stageId: copy.stageId,
  });
  const before = await snapshot(f);
  expect((await item(f)).status).toBe("NEEDS_SYNCHRONIZATION");
  await expect(
    adjudication.adjudicatePooledConflict(
      ctx(f),
      f.guideline.id,
      await input(f),
    ),
  ).rejects.toThrow();
  expect(await snapshot(f)).toEqual(before);
});

it("hides withdrawn votes and refuses a stale conflict with insufficient live reviews", async () => {
  const f = await fixture();
  const oldRequest = await input(f);
  // Deliberately seed the inconsistent historical edge case: withdrawal happened,
  // but OPEN conflict markers survived. A normal withdrawal recomputes conflicts.
  const withdrawal = await prisma.screeningWithdrawal.create({
    data: {
      id: randomUUID(),
      guidelineId: f.guideline.id,
      poolId: f.pool.id,
      reviewerId: f.users[1]!.id,
      actorId: f.owner.id,
      reason: "Historical withdrawn-vote fixture",
      manifest: {},
      summary: {},
    },
  });
  await prisma.screeningDecision.updateMany({
    where: { citationId: { in: citationIds(f) }, reviewerId: f.users[1]!.id },
    data: { withdrawnAt: new Date(), withdrawalId: withdrawal.id },
  });
  await prisma.screeningAssignment.updateMany({
    where: { citationId: { in: citationIds(f) }, reviewerId: f.users[1]!.id },
    data: { status: "PENDING" },
  });
  const before = await snapshot(f);
  const row = await item(f);
  expect(row.decisions.every((d) => d.reviewer.id !== f.users[1]!.id)).toBe(
    true,
  );
  expect(row.status).toBe("NEEDS_SYNCHRONIZATION");
  expect(row.stateToken).not.toBe(oldRequest.stateToken);
  await expect(
    adjudication.adjudicatePooledConflict(ctx(f), f.guideline.id, oldRequest),
  ).rejects.toThrow();
  await expect(
    adjudication.adjudicatePooledConflict(ctx(f), f.guideline.id, {
      ...oldRequest,
      stateToken: row.stateToken,
    }),
  ).rejects.toThrow();
  expect(await snapshot(f)).toEqual(before);
});

it("requires adjudication permission in every PICO, including copies outside the selected abstract", async () => {
  const f = await fixture();
  const request = await input(f);
  const actor = await createTestUser();
  await prisma.organizationMember.create({
    data: { orgId: f.org.id, userId: actor.id, role: "MEMBER" },
  });
  await prisma.projectMember.createMany({
    data: [f.guideline.id, ...f.picos.slice(1, 5).map((p) => p.id)].map(
      (projectId) => ({
        projectId,
        userId: actor.id,
        roles: ["ADJUDICATOR" as const],
      }),
    ),
  });
  // PICO 6 is in the pool but has no copy of this abstract. Its permission is still required.
  const before = await snapshot(f);
  await expect(
    adjudication.listPooledConflicts({ userId: actor.id }, f.guideline.id, {
      poolId: f.pool.id,
    }),
  ).rejects.toMatchObject({ code: "FORBIDDEN" });
  await expect(
    adjudication.adjudicatePooledConflict(
      { userId: actor.id },
      f.guideline.id,
      request,
    ),
  ).rejects.toMatchObject({ code: "FORBIDDEN" });
  expect(await snapshot(f)).toEqual(before);
});

it.each(["missing label", "inactive in one PICO"] as const)(
  "rejects exclusion with %s atomically",
  async (scenario) => {
    const f = await fixture();
    if (scenario === "inactive in one PICO") {
      await prisma.exclusionReason.updateMany({
        where: { projectId: f.picos[5]!.id, label: "Wrong population" },
        data: { isActive: false },
      });
    }
    const request = await input(f);
    const before = await snapshot(f);
    await expect(
      adjudication.adjudicatePooledConflict(ctx(f), f.guideline.id, {
        ...request,
        finalDecision: "EXCLUDE",
        ...(scenario === "inactive in one PICO"
          ? { exclusionReasonLabel: "Wrong population" }
          : {}),
      }),
    ).rejects.toThrow();
    expect(await snapshot(f)).toEqual(before);
  },
);

it.each(["assignment", "decision", "result"] as const)(
  "rejects pooled reopening when a downstream full-text %s exists",
  async (kind) => {
    const f = await fixture();
    await adjudication.adjudicatePooledConflict(
      ctx(f),
      f.guideline.id,
      await input(f),
    );
    const copy = f.groups[0]![0]!;
    const stage = await prisma.screeningStage.findUniqueOrThrow({
      where: {
        projectId_type: { projectId: copy.projectId, type: "FULL_TEXT" },
      },
    });
    const scope = { stageId: stage.id, citationId: copy.id };
    if (kind === "assignment")
      await prisma.screeningAssignment.create({
        data: { ...scope, reviewerId: f.users[0]!.id },
      });
    if (kind === "decision")
      await prisma.screeningDecision.create({
        data: {
          ...scope,
          reviewerId: f.users[0]!.id,
          decision: "INCLUDE",
          labels: [],
        },
      });
    if (kind === "result")
      await prisma.citationStageResult.create({
        data: { ...scope, outcome: "INCLUDE", resolvedVia: "CONSENSUS" },
      });
    const before = await snapshot(f);
    await expect(
      adjudication.reopenPooledConflict(ctx(f), f.guideline.id, await input(f)),
    ).rejects.toMatchObject({ code: "INVALID_STATE" });
    expect(await snapshot(f)).toEqual(before);
  },
);

it.each(["INCLUDE", "EXCLUDE"] as const)(
  "reopens synchronized pooled %s consensus without requiring adjudication rows",
  async (decision) => {
    const f = await pooledReadinessFixture({ count: 1, reviewers: 2 });
    await f.decide(0, 0, decision, "First consensus review");
    await f.decide(1, 0, decision, "Second consensus review");
    const before = await snapshot(f);
    expect(before.results).toHaveLength(3);
    expect(
      before.results.every(
        (r) => r.resolvedVia === "CONSENSUS" && r.outcome === decision,
      ),
    ).toBe(true);
    expect(before.conflicts).toHaveLength(0);
    const row = await item(f);
    expect(row.status).toBe("RESOLVED");
    expect(row.adjudication).toBeNull();
    const request = await input(f);
    // Settled consensus is reopenable, not an open conflict to adjudicate directly.
    await expect(
      adjudication.adjudicatePooledConflict(ctx(f), f.guideline.id, request),
    ).rejects.toThrow();
    expect(await snapshot(f)).toEqual(before);
    await adjudication.reopenPooledConflict(ctx(f), f.guideline.id, {
      ...request,
      reason: "Reassess consensus under corrected criteria",
    });
    const after = await snapshot(f);
    expect(after.results).toHaveLength(0);
    expect(after.conflicts).toHaveLength(0);
    expect(after.votes).toEqual(before.votes);
    expect(after.assignments).toEqual(before.assignments);
    expect(after.quotas).toEqual(before.quotas);
    await expect(
      adjudication.reopenPooledConflict(ctx(f), f.guideline.id, request),
    ).rejects.toThrow();
    expect(await snapshot(f)).toEqual(after);
    // A fresh opposite vote creates the ordinary pooled conflict again.
    await f.decide(
      0,
      0,
      decision === "INCLUDE" ? "EXCLUDE" : "INCLUDE",
      "Changed my assessment after reopening",
    );
    expect((await item(f)).status).toBe("OPEN");
    await adjudication.adjudicatePooledConflict(
      ctx(f),
      f.guideline.id,
      await input(f),
    );
    expect(
      (await snapshot(f)).results.every(
        (r) => r.outcome === "INCLUDE" && r.resolvedVia === "ADJUDICATION",
      ),
    ).toBe(true);
  },
);

it("serializes pooled reopening against concurrent full-text assignment creation", async () => {
  const f = await fixture();
  await adjudication.adjudicatePooledConflict(
    ctx(f),
    f.guideline.id,
    await input(f),
  );
  const request = await input(f);
  const copy = f.groups[0]![0]!;
  const stage = await prisma.screeningStage.findUniqueOrThrow({
    where: { projectId_type: { projectId: copy.projectId, type: "FULL_TEXT" } },
  });
  const results = await Promise.allSettled([
    screening.createAssignments(ctx(f), copy.projectId, stage.id, {
      reviewerIds: [f.users[0]!.id],
      citationIds: [copy.id],
      strategy: "all",
    }),
    adjudication.reopenPooledConflict(ctx(f), f.guideline.id, request),
  ]);
  const fullTextAssignments = await prisma.screeningAssignment.count({
    where: {
      stageId: stage.id,
      citationId: copy.id,
      status: { not: "VOIDED" },
    },
  });
  const titleAbstractResults = await prisma.citationStageResult.findMany({
    where: {
      citationId: { in: citationIds(f) },
      stage: { type: "TITLE_ABSTRACT" },
    },
  });
  expect(results[0]!.status).toBe("fulfilled");
  if (fullTextAssignments > 0) {
    expect(results[1]!.status).toBe("rejected");
    expect(titleAbstractResults).toHaveLength(3);
    expect(titleAbstractResults.every((r) => r.outcome === "INCLUDE")).toBe(
      true,
    );
  } else {
    expect(results[1]!.status).toBe("fulfilled");
    expect(titleAbstractResults).toHaveLength(0);
  }
});

it("measures listing and one adjudication across a realistic 4110-abstract pool", async () => {
  const f = await pooledReadinessFixture({
    count: 4110,
    reviewers: 40,
    seededProgress: true,
  });
  const groupIndex = 4000;
  await f.decide(0, groupIndex, "INCLUDE", "Scale fixture inclusion");
  await f.decide(1, groupIndex, "EXCLUDE", "Scale fixture exclusion");
  const started = performance.now();
  const listing = await adjudication.listPooledConflicts(
    ctx(f),
    f.guideline.id,
    { poolId: f.pool.id },
  );
  const listMs = Math.round(performance.now() - started);
  expect(listing.summary).toMatchObject({
    open: 1,
    resolved: 2000,
    needsSynchronization: 0,
  });
  const selectedIds = f.groups[groupIndex]!.map((c) => c.id);
  const selected = listing.items.find((row) =>
    row.citationIds.includes(selectedIds[0]!),
  );
  expect(selected?.status).toBe("OPEN");
  expect([...selected!.citationIds].sort()).toEqual([...selectedIds].sort());
  const writeStarted = performance.now();
  await adjudication.adjudicatePooledConflict(ctx(f), f.guideline.id, {
    poolId: f.pool.id,
    citationIds: selected!.citationIds,
    stateToken: selected!.stateToken,
    finalDecision: "INCLUDE",
    reason: "Resolved disagreement in scale fixture",
  });
  const adjudicateMs = Math.round(performance.now() - writeStarted);
  const selectedResults = await prisma.citationStageResult.findMany({
    where: { citationId: { in: selectedIds } },
  });
  expect(selectedResults).toHaveLength(selectedIds.length);
  expect(
    selectedResults.every(
      (r) => r.outcome === "INCLUDE" && r.resolvedVia === "ADJUDICATION",
    ),
  ).toBe(true);
  const originalConsensusCopies = f.groups
    .slice(0, 2000)
    .flat()
    .map((c) => c.id);
  expect(
    await prisma.citationStageResult.count({
      where: {
        citationId: { in: originalConsensusCopies },
        resolvedVia: "CONSENSUS",
      },
    }),
  ).toBe(originalConsensusCopies.length);
  // Diagnostic timings only: hardware-dependent durations are not correctness gates.
  console.info(
    "Pooled adjudication scale",
    JSON.stringify({
      abstracts: 4110,
      listed: listing.items.length,
      responseBytes: Buffer.byteLength(JSON.stringify(listing)),
      listMs,
      adjudicateMs,
    }),
  );
}, 180_000);

const staleContextCases = (["adjudicate", "reopen"] as const).flatMap(
  (operation) =>
    (
      [
        "citation title",
        "citation abstract",
        "criterion create",
        "criterion update",
        "criterion delete",
      ] as const
    ).map((change) => ({ operation, change })),
);
it.each(staleContextCases)(
  "rejects stale $operation after $change and accepts refreshed context",
  async ({ operation, change }) => {
    const f = await fixture();
    const copy = f.groups[0]![0]!;
    const protocol = await prisma.protocol.upsert({
      where: { projectId: copy.projectId },
      create: { projectId: copy.projectId },
      update: {},
    });
    const criterion = await prisma.eligibilityCriterion.create({
      data: {
        protocolId: protocol.id,
        type: "INCLUSION",
        category: "population",
        text: "Original eligibility population",
      },
    });
    if (operation === "reopen")
      await adjudication.adjudicatePooledConflict(
        ctx(f),
        f.guideline.id,
        await input(f),
      );
    if (change === "citation abstract")
      await prisma.citation.update({
        where: { id: copy.id },
        data: { abstract: null },
      });
    const oldRequest = await input(f);
    const amendmentReason = "Correct clinical context after screening began";
    if (change === "citation title")
      await prisma.citation.update({
        where: { id: copy.id },
        data: { title: "Corrected title with materially different population" },
      });
    if (change === "citation abstract")
      await citations.addCitationAbstract(ctx(f), copy.projectId, copy.id, {
        abstract: "Corrected study abstract. ".repeat(150),
      });
    if (change === "criterion create")
      await protocols.createCriterion(ctx(f), copy.projectId, {
        type: "EXCLUSION",
        category: "design",
        text: "Exclude retrospective studies",
        amendmentReason,
      });
    if (change === "criterion update")
      await protocols.updateCriterion(ctx(f), copy.projectId, criterion.id, {
        text: "Updated population: adults only",
        amendmentReason,
      });
    if (change === "criterion delete")
      await protocols.deleteCriterion(ctx(f), copy.projectId, criterion.id, {
        amendmentReason,
      });
    const before = await snapshot(f);
    const freshRequest = await input(f);
    expect(freshRequest.stateToken).not.toBe(oldRequest.stateToken);
    const execute =
      operation === "adjudicate"
        ? adjudication.adjudicatePooledConflict
        : adjudication.reopenPooledConflict;
    await expect(
      execute(ctx(f), f.guideline.id, oldRequest),
    ).rejects.toMatchObject({ code: "INVALID_STATE" });
    expect(await snapshot(f)).toEqual(before);
    await execute(ctx(f), f.guideline.id, freshRequest);
    const after = await snapshot(f);
    if (operation === "adjudicate") {
      expect(after.results).toHaveLength(citationIds(f).length);
      expect(after.conflicts.every((c) => c.status === "RESOLVED")).toBe(true);
    } else {
      expect(after.results).toHaveLength(0);
      expect(after.conflicts.every((c) => c.status === "VOIDED")).toBe(true);
    }
  },
);

it("keeps adjudication creation dates while exposing the effective date of the latest rationale", async () => {
  const f = await fixture();
  await adjudication.adjudicatePooledConflict(ctx(f), f.guideline.id, {
    ...(await input(f)),
    reason: "Original adjudication rationale",
  });
  const original = await snapshot(f);
  const historicalCreatedAt = new Date("2001-01-01T00:00:00.000Z");
  // Model a long-lived adjudication record that is updated in place on reconsideration.
  await prisma.screeningAdjudication.updateMany({
    where: { conflictId: { in: original.conflicts.map((c) => c.id) } },
    data: { createdAt: historicalCreatedAt },
  });
  const firstResolved = await item(f);
  expect(firstResolved.historicalAdjudications).toHaveLength(
    citationIds(f).length,
  );
  for (const history of firstResolved.historicalAdjudications) {
    const conflict = original.conflicts.find(
      (c) => c.citationId === history.citationId,
    )!;
    expect(new Date(history.effectiveAt!).getTime()).toBe(
      conflict.resolvedAt!.getTime(),
    );
    expect(history.adjudication.createdAt).toEqual(historicalCreatedAt);
  }
  await adjudication.reopenPooledConflict(ctx(f), f.guideline.id, {
    ...(await input(f)),
    reason: "Reconsider original rationale",
  });
  await f.decide(0, 0, "INCLUDE", "Fresh review after reconsideration");
  const reopened = await item(f);
  expect(reopened.status).toBe("OPEN");
  for (const history of reopened.historicalAdjudications) {
    const earlier = firstResolved.historicalAdjudications.find(
      (h) => h.citationId === history.citationId,
    )!;
    expect(new Date(history.effectiveAt!).getTime()).toBe(
      new Date(earlier.effectiveAt!).getTime(),
    );
    expect(history.adjudication.reason).toBe("Original adjudication rationale");
  }
  await adjudication.adjudicatePooledConflict(ctx(f), f.guideline.id, {
    ...(await input(f)),
    finalDecision: "EXCLUDE",
    exclusionReasonLabel: "Wrong population",
    reason: "Replacement rationale after reconsideration",
  });
  const latest = await item(f);
  const final = await snapshot(f);
  expect(latest.status).toBe("RESOLVED");
  for (const history of latest.historicalAdjudications) {
    const conflict = final.conflicts.find(
      (c) => c.citationId === history.citationId,
    )!;
    const previous = original.conflicts.find(
      (c) => c.citationId === history.citationId,
    )!;
    expect(history.adjudication.id).toBe(previous.adjudication!.id);
    expect(history.adjudication.createdAt).toEqual(historicalCreatedAt);
    expect(history.adjudication.reason).toBe(
      "Replacement rationale after reconsideration",
    );
    expect(new Date(history.effectiveAt!).getTime()).toBe(
      conflict.resolvedAt!.getTime(),
    );
    expect(new Date(history.effectiveAt!).getTime()).toBeGreaterThan(
      historicalCreatedAt.getTime(),
    );
    expect(new Date(history.effectiveAt!).getTime()).toBeGreaterThanOrEqual(
      previous.resolvedAt!.getTime(),
    );
  }
});

it.each(["abstract", "criterion"] as const)(
  "holds %s context writers until pooled adjudication commits",
  async (kind) => {
    const f = await fixture();
    const copy = f.groups[0]![0]!;
    if (kind === "abstract")
      await prisma.citation.update({
        where: { id: copy.id },
        data: { abstract: null },
      });
    const request = await input(f);
    let entered!: () => void;
    let release!: () => void;
    const insideWrite = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const originalRecord = audit.record;
    let paused = false;
    vi.spyOn(audit, "record").mockImplementation(async (...args) => {
      const result = await originalRecord(...args);
      if (
        !paused &&
        args[1].action === audit.AuditActions.SCREENING_CONFLICT_ADJUDICATED
      ) {
        paused = true;
        entered();
        await gate;
      }
      return result;
    });
    const committing = adjudication.adjudicatePooledConflict(
      ctx(f),
      f.guideline.id,
      request,
    );
    // Attach a rejection handler immediately so cleanup can safely await either result.
    const committed = committing.then(
      (value) => ({ ok: true as const, value }),
      (error: unknown) => ({ ok: false as const, error }),
    );
    let contextWrite: Promise<{ ok: boolean; error?: unknown }> | undefined;
    try {
      await Promise.race([
        insideWrite,
        new Promise<never>((_, reject) =>
          setTimeout(
            () =>
              reject(
                new Error("Adjudication did not reach held audit boundary"),
              ),
            3000,
          ),
        ),
      ]);
      let settled = false;
      const edit =
        kind === "abstract"
          ? citations.addCitationAbstract(ctx(f), copy.projectId, copy.id, {
              abstract: "New clinical context arriving during adjudication",
            })
          : protocols.createCriterion(ctx(f), copy.projectId, {
              type: "EXCLUSION",
              text: "Exclude retrospective studies",
              amendmentReason: "Correct eligibility context during screening",
            });
      contextWrite = edit.then(
        () => {
          settled = true;
          return { ok: true };
        },
        (error: unknown) => {
          settled = true;
          return { ok: false, error };
        },
      );
      // The adjudicator holds its transaction open at a real post-write boundary.
      // The context edit must not finish (or fail spuriously) while those locks are held.
      await new Promise((resolve) => setTimeout(resolve, 150));
      expect(settled).toBe(false);
      expect(
        await prisma.citationStageResult.count({
          where: { citationId: { in: citationIds(f) } },
        }),
      ).toBe(0);
      release();
      expect((await committed).ok).toBe(true);
      expect((await contextWrite).ok).toBe(true);
      const after = await snapshot(f);
      expect(after.results).toHaveLength(citationIds(f).length);
      expect(after.results.every((r) => r.outcome === "INCLUDE")).toBe(true);
      if (kind === "abstract")
        expect(
          await prisma.citation.findUnique({ where: { id: copy.id } }),
        ).toMatchObject({
          abstract: "New clinical context arriving during adjudication",
        });
      else
        expect(
          await prisma.eligibilityCriterion.count({
            where: {
              protocol: { projectId: copy.projectId },
              text: "Exclude retrospective studies",
            },
          }),
        ).toBe(1);
    } finally {
      release();
      await committed;
      if (contextWrite) await contextWrite;
    }
  },
);
