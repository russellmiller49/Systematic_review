import { beforeAll, describe, expect, it, vi } from "vitest";
import { prisma } from "@/server/db";
import * as projects from "@/server/services/projects";
import * as pooled from "@/server/services/screening/pooled";
import * as screening from "@/server/services/screening";
import * as quotas from "@/server/services/screening/quotas";
import * as audit from "@/server/services/audit";
import { resetDb } from "../db-utils";
import {
  addProjectMember,
  createProjectWithTeam,
  createTestCitation,
} from "../factories";

const ctx = (userId: string) => ({ userId });
async function setup(target = 10, count = 5) {
  const team = await createProjectWithTeam();
  const guideline = await projects.createProject(
    ctx(team.owner.id),
    team.org.id,
    {
      title: "Open queue guideline",
      reviewType: "GUIDELINE_EVIDENCE_REVIEW",
      isGuideline: true,
      reviewersPerCitation: 2,
    },
  );
  for (const user of [team.reviewer1, team.reviewer2, team.adjudicator])
    await addProjectMember(guideline.id, user.id, ["REVIEWER"]);
  const picos = [];
  for (let i = 1; i <= 4; i++)
    picos.push(
      await projects.createSubProject(ctx(team.owner.id), guideline.id, {
        title: `PICO ${i}`,
        researchQuestion: `Question ${i}`,
      }),
    );
  const pool = await pooled.saveGuidelineScreeningPool(
    ctx(team.owner.id),
    guideline.id,
    {
      name: "Open pooled abstracts",
      projectIds: picos.slice(1).map((p) => p.id),
    },
  );
  const groups: string[][] = [];
  for (let i = 0; i < count; i++) {
    const ids = [];
    for (const pico of picos.slice(1))
      ids.push(
        (
          await createTestCitation(pico.id, {
            title: `Abstract ${String(i + 1).padStart(3, "0")}`,
            doi: `10.1234/open-${i}`,
            pmid: String(7000 + i),
            abstract: `Full abstract content number ${i}.`,
          })
        ).id,
      );
    groups.push(ids);
  }
  const targetFor = (reviewerId: string, next: number) =>
    quotas.saveQuotas(
      ctx(team.owner.id),
      guideline.id,
      { poolId: pool.id },
      { reviewers: [{ reviewerId, target: next }] },
    );
  for (const user of [team.reviewer1, team.reviewer2, team.adjudicator])
    await targetFor(user.id, target);
  const queue = (
    userId = team.reviewer1.id,
    query: Partial<{
      page: number;
      limit: number;
      status: "AVAILABLE" | "MY_REVIEWED" | "ALL";
      q: string;
    }> = {},
  ) =>
    pooled.getPooledQueue(ctx(userId), guideline.id, {
      poolId: pool.id,
      ...query,
    });
  const decide = (
    userId: string,
    index: number,
    decision: "INCLUDE" | "EXCLUDE" | "MAYBE" = "INCLUDE",
    notes?: string,
  ) =>
    pooled.createPooledDecision(ctx(userId), guideline.id, {
      poolId: pool.id,
      citationIds: groups[index]!,
      decision,
      notes,
      ...(decision === "EXCLUDE"
        ? { exclusionReasonLabel: "Wrong population" }
        : {}),
    });
  return { ...team, guideline, picos, pool, groups, queue, decide, targetFor };
}

describe("quota-authorized pooled open queue", () => {
  beforeAll(resetDb);

  it("A/K: exposes 100 logical abstracts for target 10, pages/searches all copies, and browsing has no writes", async () => {
    const f = await setup(10, 100);
    const beforeAudit = await prisma.auditEvent.count();
    const first = await f.queue();
    const second = await f.queue(undefined, { page: 2 });
    expect(first.quota).toEqual({ target: 10, completed: 0, remaining: 10 });
    expect(first.pagination).toEqual({
      page: 1,
      limit: 50,
      total: 100,
      totalPages: 2,
    });
    expect(first.items).toHaveLength(50);
    expect(second.items).toHaveLength(50);
    expect(
      new Set([...first.items, ...second.items].map((i) => i.id)).size,
    ).toBe(100);
    expect(first.items[0]?.citationIds).toHaveLength(3);
    expect((await f.queue(undefined, { page: 99 })).pagination.page).toBe(2);
    await prisma.citation.update({
      where: { id: f.groups[72]![1] },
      data: {
        abstract: "Hidden-copy search term",
        authors: [{ family: "NeedleAuthor" }],
      },
    });
    for (const q of [
      "abstract 073",
      "hidden-copy search",
      "NEEDLEAUTHOR",
      "10.1234/open-72",
      "7072",
    ]) {
      const searched = await f.queue(undefined, { q });
      expect(searched.total).toBe(1);
      expect(searched.items[0]?.citationIds).toEqual([...f.groups[72]!].sort());
    }
    expect((await f.queue(undefined, { q: "%' OR 1=1 --" })).total).toBe(0);
    expect(
      await prisma.screeningAssignment.count({
        where: { citationId: { in: f.groups.flat() } },
      }),
    ).toBe(0);
    expect(
      await prisma.screeningDecision.count({
        where: { citationId: { in: f.groups.flat() } },
      }),
    ).toBe(0);
    expect(await prisma.auditEvent.count()).toBe(beforeAudit);
  });

  it("B/C/D/G/H/I/J: arbitrary E/B/D selection counts once, preserves skipped A/C, and target changes preserve history", async () => {
    const f = await setup(3);
    await f.queue(); // opening A has no effect
    for (const index of [4, 1, 3])
      await f.decide(f.reviewer1.id, index, "INCLUDE", "Saved pooled note");
    expect((await f.queue()).quota).toEqual({
      target: 3,
      completed: 3,
      remaining: 0,
    });
    expect((await f.queue()).total).toBe(0);
    const skipped = [f.groups[0]!, f.groups[2]!].flat();
    expect(
      await prisma.screeningAssignment.count({
        where: { citationId: { in: skipped } },
      }),
    ).toBe(0);
    expect(
      await prisma.screeningDecision.count({
        where: { citationId: { in: skipped } },
      }),
    ).toBe(0);
    expect((await f.queue(f.reviewer2.id)).total).toBe(5);
    const decisions = await prisma.screeningDecision.findMany({
      where: {
        reviewerId: f.reviewer1.id,
        citationId: { in: f.groups.flat() },
      },
    });
    expect(decisions).toHaveLength(9);
    expect(decisions.every((d) => d.notes === "Saved pooled note")).toBe(true);
    const history = await f.queue(undefined, { status: "MY_REVIEWED" });
    expect(history.items).toHaveLength(3);
    expect(
      history.items.every(
        (i) => i.myDecision?.notes === "Saved pooled note" && i.canDecide,
      ),
    ).toBe(true);
    await expect(f.decide(f.reviewer1.id, 0)).rejects.toMatchObject({
      code: "INVALID_STATE",
    });
    // Revision at the target preserves the note when omitted and doesn't consume quota.
    await f.decide(f.reviewer1.id, 4, "MAYBE");
    expect(
      (await f.queue(undefined, { status: "MY_REVIEWED", q: "Abstract 005" }))
        .items[0]?.myDecision,
    ).toEqual({ decision: "MAYBE", notes: "Saved pooled note" });
    await f.targetFor(f.reviewer1.id, 5);
    expect((await f.queue()).quota).toEqual({
      target: 5,
      completed: 3,
      remaining: 2,
    });
    expect(
      (await f.queue()).items
        .map((i) => i.citationIds)
        .flat()
        .sort(),
    ).toEqual(skipped.sort());
    await f.decide(f.reviewer1.id, 0);
    await f.decide(f.reviewer1.id, 2);
    await f.targetFor(f.reviewer1.id, 3);
    expect((await f.queue()).quota).toEqual({
      target: 3,
      completed: 5,
      remaining: 0,
    });
    await f.targetFor(f.reviewer1.id, 0);
    expect((await f.queue()).quota).toEqual({
      target: 0,
      completed: 5,
      remaining: 0,
    });
    expect((await f.queue(undefined, { status: "MY_REVIEWED" })).total).toBe(5);
    expect(
      await prisma.screeningDecision.count({
        where: {
          reviewerId: f.reviewer1.id,
          citationId: { in: f.groups.flat() },
        },
      }),
    ).toBe(15);
  });

  it("E/F: last-slot races reject the loser without assignments, decisions, quota consumption, or vote leaks", async () => {
    const f = await setup(2, 2);
    await f.decide(f.reviewer1.id, 0, "EXCLUDE", "Secret note from reviewer A");
    expect((await f.queue()).total).toBe(1);
    const visible = await f.queue(f.reviewer2.id);
    expect(visible.items[0]).toMatchObject({
      completedReviews: 1,
      requiredReviews: 2,
      myDecision: null,
    });
    expect(JSON.stringify(visible)).not.toContain("Secret note");
    expect(JSON.stringify(visible.items[0])).not.toContain("EXCLUDE");
    expect(JSON.stringify(visible)).not.toContain(f.reviewer1.id);
    const candidates = [f.reviewer2, f.adjudicator];
    const results = await Promise.allSettled(
      candidates.map((u) => f.decide(u.id, 0, "MAYBE")),
    );
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const loser =
      candidates[results.findIndex((r) => r.status === "rejected")]!;
    expect(results.find((r) => r.status === "rejected")).toMatchObject({
      reason: {
        code: "INVALID_STATE",
        message:
          "This abstract has just received all required reviews. Choose another abstract.",
      },
    });
    expect((await f.queue(loser.id)).quota?.completed).toBe(0);
    expect(
      (await f.queue(loser.id)).items.map((i) => i.citationIds).flat(),
    ).not.toContain(f.groups[0]![0]);
    expect(
      await prisma.screeningAssignment.count({
        where: { reviewerId: loser.id, citationId: { in: f.groups[0] } },
      }),
    ).toBe(0);
    expect(
      await prisma.screeningDecision.count({
        where: { citationId: { in: f.groups[0] } },
      }),
    ).toBe(6);
    expect(
      await prisma.screeningConflict.count({
        where: { citationId: { in: f.groups[0] }, status: "OPEN" },
      }),
    ).toBe(3);
    // Two tabs for one reviewer also cannot overspend their final quota slot.
    await f.targetFor(loser.id, 1);
    const competing = await Promise.allSettled([
      f.decide(loser.id, 1),
      f.decide(loser.id, 1),
    ]);
    expect(competing.every((r) => r.status === "fulfilled")).toBe(true); // duplicate is an idempotent revision
    expect((await f.queue(loser.id)).quota).toEqual({
      target: 1,
      completed: 1,
      remaining: 0,
    });
  });

  it("serializes two different choices from one reviewer with one quota slot left", async () => {
    const f = await setup(1, 2);
    const results = await Promise.allSettled([
      f.decide(f.reviewer1.id, 0),
      f.decide(f.reviewer1.id, 1),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(
      await prisma.screeningDecision.count({
        where: { citationId: { in: f.groups.flat() } },
      }),
    ).toBe(3);
    expect((await f.queue()).quota).toEqual({
      target: 1,
      completed: 1,
      remaining: 0,
    });
  });

  it.each([true, false])(
    "L: Maybe uses ordinary conflict semantics (maybeGeneratesConflict=%s)",
    async (maybeGeneratesConflict) => {
      const f = await setup(3, 2);
      await prisma.screeningStage.updateMany({
        where: {
          projectId: { in: f.picos.slice(1).map((p) => p.id) },
          type: "TITLE_ABSTRACT",
        },
        data: { maybeGeneratesConflict },
      });
      await f.decide(f.reviewer1.id, 0, "MAYBE", "Uncertain eligibility");
      await f.decide(f.reviewer2.id, 0, "INCLUDE");
      expect(
        await prisma.screeningDecision.count({
          where: {
            citationId: { in: f.groups[0] },
            decision: "MAYBE",
            notes: "Uncertain eligibility",
          },
        }),
      ).toBe(3);
      expect(
        await prisma.screeningConflict.count({
          where: { citationId: { in: f.groups[0] }, status: "OPEN" },
        }),
      ).toBe(maybeGeneratesConflict ? 3 : 0);
      expect(
        await prisma.citationStageResult.count({
          where: { citationId: { in: f.groups[0] } },
        }),
      ).toBe(0);
      expect((await f.queue(f.adjudicator.id)).total).toBe(1);
      await f.decide(f.reviewer1.id, 1, "MAYBE");
      await f.decide(f.reviewer2.id, 1, "MAYBE");
      expect(
        await prisma.screeningConflict.count({
          where: { citationId: { in: f.groups[1] }, status: "OPEN" },
        }),
      ).toBe(3);
      expect((await f.queue()).quota?.completed).toBe(2);
    },
  );

  it("M/N: pool health is independent of the owner and separates synchronized final outcomes from exceptional states", async () => {
    const f = await setup(10, 4);
    const before = await f.queue(f.owner.id);
    expect(before.summary.available).toBe(0);
    expect(before.adminSummary).toMatchObject({
      needsAdditionalReviews: 4,
      unreviewed: 4,
      needsSynchronization: 0,
    });
    await f.decide(f.reviewer1.id, 0);
    await f.decide(f.reviewer2.id, 0);
    await f.decide(f.reviewer1.id, 1);
    // Partial historical decision: cannot fill in missing copies as if it were a new review.
    await prisma.screeningDecision.deleteMany({
      where: { citationId: f.groups[1]![2], reviewerId: f.reviewer1.id },
    });
    // A single independently finalized copy is not a normally completed pooled abstract.
    const stage = await prisma.screeningStage.findUniqueOrThrow({
      where: {
        projectId_type: { projectId: f.picos[1]!.id, type: "TITLE_ABSTRACT" },
      },
    });
    await prisma.citationStageResult.create({
      data: {
        stageId: stage.id,
        citationId: f.groups[2]![0]!,
        outcome: "EXCLUDE",
        resolvedVia: "ADJUDICATION",
      },
    });
    const admin = await f.queue(f.owner.id, { status: "ALL" });
    expect(admin.adminSummary).toMatchObject({
      finalized: 1,
      needsSynchronization: 2,
      needsAdditionalReviews: 1,
      unreviewed: 1,
    });
    expect(admin.items.filter((i) => i.needsSynchronization)).toHaveLength(2);
    expect(
      (await f.queue(f.reviewer2.id)).items.map((i) => i.citationIds).flat(),
    ).toEqual([...f.groups[3]!].sort());
    await expect(f.decide(f.reviewer2.id, 1)).rejects.toMatchObject({
      code: "INVALID_STATE",
    });
    await expect(f.decide(f.reviewer2.id, 2)).rejects.toMatchObject({
      code: "INVALID_STATE",
    });
    expect((await f.queue()).quota?.completed).toBe(2); // historical work is preserved
    await expect(
      f.queue(f.reviewer1.id, { status: "ALL" }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect((await f.queue()).adminSummary).toBeNull();
  });

  it("rejects different reviewers/notes on linked records, voided assignments, and stale incomplete group IDs", async () => {
    const f = await setup(5, 3);
    await f.decide(f.reviewer1.id, 0);
    await prisma.screeningDecision.updateMany({
      where: { citationId: f.groups[0]![0], reviewerId: f.reviewer1.id },
      data: { notes: "Inconsistent note" },
    });
    const stage = await prisma.screeningStage.findUniqueOrThrow({
      where: {
        projectId_type: { projectId: f.picos[1]!.id, type: "TITLE_ABSTRACT" },
      },
    });
    await prisma.screeningAssignment.create({
      data: {
        stageId: stage.id,
        citationId: f.groups[1]![0]!,
        reviewerId: f.reviewer1.id,
        status: "VOIDED",
      },
    });
    expect((await f.queue()).total).toBe(1);
    await expect(f.decide(f.reviewer1.id, 1)).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    await expect(
      pooled.createPooledDecision(ctx(f.reviewer1.id), f.guideline.id, {
        poolId: f.pool.id,
        citationIds: f.groups[2]!.slice(0, 2),
        decision: "INCLUDE",
      }),
    ).rejects.toMatchObject({ code: "INVALID_STATE" });
    expect(
      await prisma.screeningDecision.count({
        where: { citationId: { in: f.groups[2] } },
      }),
    ).toBe(0);
  });

  it("rolls back linked decisions, assignments, and audit rows when a later linked write fails", async () => {
    const f = await setup(2, 1);
    const before = await prisma.auditEvent.count();
    const originalRecord = audit.record;
    let decisionWrites = 0;
    const spy = vi
      .spyOn(audit, "record")
      .mockImplementation(async (tx, input) => {
        if (
          input.action === "screening.decision.created" &&
          ++decisionWrites === 3
        )
          throw new Error("Injected third-record audit failure");
        return originalRecord(tx, input);
      });
    try {
      await expect(f.decide(f.reviewer1.id, 0)).rejects.toThrow(
        "Injected third-record",
      );
      expect(decisionWrites).toBe(3);
    } finally {
      spy.mockRestore();
    }
    expect(
      await prisma.screeningAssignment.count({
        where: { citationId: { in: f.groups[0] } },
      }),
    ).toBe(0);
    expect(
      await prisma.screeningDecision.count({
        where: { citationId: { in: f.groups[0] } },
      }),
    ).toBe(0);
    expect(await prisma.auditEvent.count()).toBe(before);
    expect((await f.queue()).quota?.completed).toBe(0);
  });

  it("retains completed fixed work, requires common exclusion reasons, and keeps PICO 1 independent", async () => {
    const f = await setup(5, 2);
    await prisma.screeningQuota.deleteMany({
      where: { poolId: f.pool.id, reviewerId: f.reviewer1.id },
    });
    await pooled.createPooledAssignments(ctx(f.owner.id), f.guideline.id, {
      poolId: f.pool.id,
      reviewerIds: [f.reviewer1.id],
      strategy: "all",
    });
    await f.decide(f.reviewer1.id, 0);
    const fixedCount = await prisma.screeningAssignment.count({
      where: {
        reviewerId: f.reviewer1.id,
        citationId: { in: f.groups.flat() },
      },
    });
    await f.targetFor(f.reviewer1.id, 2);
    expect((await f.queue()).quota).toEqual({
      target: 2,
      completed: 1,
      remaining: 1,
    });
    expect(
      await prisma.screeningAssignment.count({
        where: {
          reviewerId: f.reviewer1.id,
          citationId: { in: f.groups.flat() },
        },
      }),
    ).toBe(fixedCount);
    await prisma.exclusionReason.updateMany({
      where: { projectId: f.picos[3]!.id, label: "Wrong population" },
      data: { isActive: false },
    });
    await expect(f.decide(f.reviewer1.id, 1, "EXCLUDE")).rejects.toMatchObject({
      code: "VALIDATION",
    });
    expect((await f.queue()).quota?.remaining).toBe(1);
    const pico1 = f.picos[0]!;
    const stage = (await screening.ensureStages(pico1.id)).find(
      (s) => s.type === "TITLE_ABSTRACT",
    )!;
    const a = await createTestCitation(pico1.id);
    const b = await createTestCitation(pico1.id);
    await quotas.saveQuotas(
      ctx(f.owner.id),
      pico1.id,
      { stageId: stage.id },
      { reviewers: [{ reviewerId: f.reviewer1.id, target: 1 }] },
    );
    const individual = await screening.getScreeningNavigator(
      ctx(f.reviewer1.id),
      pico1.id,
      stage.id,
      screening.screeningNavigatorQuerySchema.parse({}),
    );
    expect(individual.pagination.total).toBe(2);
    await screening.createDecision(ctx(f.reviewer1.id), pico1.id, stage.id, {
      citationId: b.id,
      decision: "MAYBE",
    });
    expect(
      await prisma.screeningAssignment.count({ where: { citationId: a.id } }),
    ).toBe(0);
    expect((await f.queue()).quota).toEqual({
      target: 2,
      completed: 1,
      remaining: 1,
    });
  });

  it("paginates a 4,110-abstract / 9,203-record pool with a bounded response", async () => {
    const f = await setup(200, 0);
    const rows = [];
    for (let i = 0; i < 4110; i++) {
      for (let copy = 0; copy < (i < 983 ? 3 : 2); copy++) {
        rows.push({
          projectId: f.picos[copy + 1]!.id,
          title: `Scale abstract ${i}`,
          normalizedTitle: `scale abstract ${i}`,
          doi: `10.9999/scale-${i}`,
          abstract: "Representative full abstract text. ".repeat(60),
          authors: [{ family: "Scale", given: "Test" }],
          createdAt: new Date(Date.UTC(2020, 0, 1) + i * 1000),
        });
      }
    }
    for (let i = 0; i < rows.length; i += 500)
      await prisma.citation.createMany({ data: rows.slice(i, i + 500) });
    const started = performance.now();
    const page = await f.queue();
    const pageMs = Math.round(performance.now() - started);
    const payloadBytes = Buffer.byteLength(JSON.stringify(page));
    expect(page.pagination.total).toBe(4110);
    expect(page.items).toHaveLength(50);
    expect(payloadBytes).toBeLessThan(250_000);
    const selected = page.items[36]!;
    const decisionStart = performance.now();
    await pooled.createPooledDecision(ctx(f.reviewer1.id), f.guideline.id, {
      poolId: f.pool.id,
      citationIds: selected.citationIds,
      decision: "INCLUDE",
    });
    const decisionMs = Math.round(performance.now() - decisionStart);
    expect((await f.queue()).quota).toEqual({
      target: 200,
      completed: 1,
      remaining: 199,
    });
    const admin = await f.queue(f.owner.id);
    expect(admin.adminSummary).toMatchObject({
      pooledAbstracts: 4110,
      linkedCitationRecords: 9203,
    });
    console.info(
      `Pooled scale check: page=${pageMs}ms, decision=${decisionMs}ms, response=${payloadBytes} bytes`,
    );
  });
});
