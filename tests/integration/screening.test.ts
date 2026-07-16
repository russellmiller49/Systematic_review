// Screening lifecycle integration tests (docs/09 R3, R5, R6, R7, R14).
// Run against your own database:
//   TEST_DATABASE_URL="postgresql://srb:srb@localhost:5442/srb_test_screening" \
//     npx vitest run --config vitest.integration.config.ts tests/integration/screening.test.ts
import { beforeAll, describe, expect, it } from "vitest";
import type { Decision, ReasonStage, StageType } from "@prisma/client";
import { prisma } from "@/server/db";
import { AppError } from "@/server/errors";
import * as screening from "@/server/services/screening";
import * as studies from "@/server/services/studies";
import { resetDb } from "../db-utils";
import {
  addOrgMember,
  addProjectMember,
  createProjectWithTeam,
  createTestCitation,
  createTestUser,
  uniq,
} from "../factories";

const ctx = (userId: string) => ({ userId });

async function expectAppError(promise: Promise<unknown>, code: string) {
  try {
    await promise;
    expect.fail(`expected AppError(${code}) but call succeeded`);
  } catch (err) {
    if (!(err instanceof AppError)) throw err;
    expect(err.code).toBe(code);
  }
}

// -- local precondition helpers (direct writes; behavior under test goes through services)

async function makeStage(
  projectId: string,
  overrides: Partial<{
    type: StageType;
    reviewersPerCitation: number;
    blinded: boolean;
    maybeGeneratesConflict: boolean;
  }> = {},
) {
  return prisma.screeningStage.create({
    data: {
      projectId,
      type: overrides.type ?? "TITLE_ABSTRACT",
      reviewersPerCitation: overrides.reviewersPerCitation ?? 2,
      blinded: overrides.blinded ?? true,
      maybeGeneratesConflict: overrides.maybeGeneratesConflict ?? true,
    },
  });
}

async function assign(stageId: string, citationId: string, reviewerId: string) {
  return prisma.screeningAssignment.create({ data: { stageId, citationId, reviewerId } });
}

async function makeReason(projectId: string, stage: ReasonStage = "BOTH") {
  return prisma.exclusionReason.create({
    data: { projectId, label: uniq("reason"), stage },
  });
}

async function taIncludeResult(taStageId: string, citationId: string) {
  return prisma.citationStageResult.create({
    data: { stageId: taStageId, citationId, outcome: "INCLUDE", resolvedVia: "CONSENSUS" },
  });
}

describe("screening service", () => {
  beforeAll(async () => {
    await resetDb();
  });

  // -------------------------------------------------------------------------
  // Stages
  // -------------------------------------------------------------------------

  it("listStages lazily creates both stages with defaults and reports progress", async () => {
    const { owner, project } = await createProjectWithTeam();
    const stages = await screening.listStages(ctx(owner.id), project.id);
    expect(stages.map((s) => s.type)).toEqual(["TITLE_ABSTRACT", "FULL_TEXT"]);
    expect(stages[0]!.reviewersPerCitation).toBe(2);
    expect(stages[0]!.progress).toEqual({
      assignedCitations: 0,
      decidedCitations: 0,
      openConflicts: 0,
      results: { total: 0, included: 0, excluded: 0 },
    });
  });

  // -------------------------------------------------------------------------
  // Assignments
  // -------------------------------------------------------------------------

  it("strategy 'all' assigns every reviewer × every eligible citation and skips existing rows", async () => {
    const { owner, reviewer1, reviewer2, project } = await createProjectWithTeam();
    const stage = await makeStage(project.id);
    for (let i = 0; i < 3; i++) await createTestCitation(project.id);

    const first = await screening.createAssignments(ctx(owner.id), project.id, stage.id, {
      reviewerIds: [reviewer1.id, reviewer2.id],
      strategy: "all",
    });
    expect(first).toMatchObject({ created: 6, skippedExisting: 0, eligibleCitations: 3 });

    const again = await screening.createAssignments(ctx(owner.id), project.id, stage.id, {
      reviewerIds: [reviewer1.id, reviewer2.id],
      strategy: "all",
    });
    expect(again).toMatchObject({ created: 0, skippedExisting: 6 });

    const event = await prisma.auditEvent.findFirstOrThrow({
      where: { entityType: "ScreeningStage", entityId: stage.id, action: "screening.assigned" },
      orderBy: { createdAt: "asc" },
    });
    expect(event.metadata).toMatchObject({ strategy: "all", created: 6 });
  });

  it("strategy 'split' gives each citation exactly reviewersPerCitation distinct reviewers", async () => {
    const { owner, reviewer1, reviewer2, adjudicator, project } = await createProjectWithTeam();
    const stage = await makeStage(project.id, { reviewersPerCitation: 2 });
    const citations = [];
    for (let i = 0; i < 4; i++) citations.push(await createTestCitation(project.id));

    const res = await screening.createAssignments(ctx(owner.id), project.id, stage.id, {
      reviewerIds: [reviewer1.id, reviewer2.id, adjudicator.id],
      strategy: "split",
    });
    expect(res.created).toBe(8);

    for (const citation of citations) {
      const rows = await prisma.screeningAssignment.findMany({
        where: { stageId: stage.id, citationId: citation.id },
      });
      expect(rows).toHaveLength(2);
      expect(new Set(rows.map((r) => r.reviewerId)).size).toBe(2);
    }

    // 422 when fewer reviewers than reviewersPerCitation
    await expectAppError(
      screening.createAssignments(ctx(owner.id), project.id, stage.id, {
        reviewerIds: [reviewer1.id],
        strategy: "split",
      }),
      "INVALID_STATE",
    );
  });

  it("rejects ineligible reviewers and non-configurers", async () => {
    const { owner, reviewer1, project, org } = await createProjectWithTeam();
    const stage = await makeStage(project.id);
    await createTestCitation(project.id);

    const observer = await createTestUser();
    await addOrgMember(org.id, observer.id);
    await addProjectMember(project.id, observer.id, ["OBSERVER"]);

    // OBSERVER lacks screening.decide
    await expectAppError(
      screening.createAssignments(ctx(owner.id), project.id, stage.id, {
        reviewerIds: [observer.id],
        strategy: "all",
      }),
      "VALIDATION",
    );
    // total stranger id
    await expectAppError(
      screening.createAssignments(ctx(owner.id), project.id, stage.id, {
        reviewerIds: ["nonexistent-user"],
        strategy: "all",
      }),
      "VALIDATION",
    );
    // a plain REVIEWER cannot configure assignments
    await expectAppError(
      screening.createAssignments(ctx(reviewer1.id), project.id, stage.id, {
        reviewerIds: [reviewer1.id],
        strategy: "all",
      }),
      "FORBIDDEN",
    );
  });

  it("lists assignment workload for admins without exposing decision content", async () => {
    const { owner, reviewer1, reviewer2, project } = await createProjectWithTeam();
    const stage = await makeStage(project.id, { reviewersPerCitation: 2 });
    const c1 = await createTestCitation(project.id);
    const c2 = await createTestCitation(project.id);
    await assign(stage.id, c1.id, reviewer1.id);
    await assign(stage.id, c1.id, reviewer2.id);
    await assign(stage.id, c2.id, reviewer1.id);
    await screening.createDecision(ctx(reviewer1.id), project.id, stage.id, {
      citationId: c1.id,
      decision: "INCLUDE",
      notes: "blind content must not appear in the admin summary",
    });

    const summary = await screening.listAssignmentAdmin(ctx(owner.id), project.id, stage.id);
    expect(summary.totals).toEqual({ assignments: 3, pending: 2, completed: 1, decisions: 1 });
    expect(summary.reviewers.find((row) => row.reviewer.id === reviewer1.id)).toMatchObject({
      assignments: 2,
      pending: 1,
      completed: 1,
      decisions: 1,
    });
    expect(JSON.stringify(summary)).not.toContain("blind content");

    await expectAppError(
      screening.listAssignmentAdmin(ctx(reviewer1.id), project.id, stage.id),
      "FORBIDDEN",
    );
  });

  it("resets only undecided pending assignments, supports reviewer scope, and audits the reason", async () => {
    const { owner, reviewer1, reviewer2, project } = await createProjectWithTeam();
    const stage = await makeStage(project.id, { reviewersPerCitation: 2 });
    const started = await createTestCitation(project.id);
    const untouched = await createTestCitation(project.id);
    await assign(stage.id, started.id, reviewer1.id);
    await assign(stage.id, started.id, reviewer2.id);
    await assign(stage.id, untouched.id, reviewer1.id);
    await screening.createDecision(ctx(reviewer1.id), project.id, stage.id, {
      citationId: started.id,
      decision: "INCLUDE",
    });

    const scoped = await screening.resetPendingAssignments(ctx(owner.id), project.id, stage.id, {
      reviewerIds: [reviewer1.id],
      reason: "Correcting reviewer allocation",
    });
    expect(scoped).toMatchObject({
      deleted: 1,
      protectedAssignments: 1,
      remainingAssignments: 1,
      affectedReviewerIds: [reviewer1.id],
    });
    expect(
      await prisma.screeningDecision.count({ where: { stageId: stage.id } }),
    ).toBe(1);

    const event = await prisma.auditEvent.findFirstOrThrow({
      where: {
        entityType: "ScreeningStage",
        entityId: stage.id,
        action: "screening.assignments.reset",
      },
    });
    expect(event.reason).toBe("Correcting reviewer allocation");
    expect(event.metadata).toMatchObject({
      scope: "selected_reviewers",
      deletedPendingAssignments: 1,
      protectedAssignments: 1,
    });

    const all = await screening.resetPendingAssignments(ctx(owner.id), project.id, stage.id, {
      reason: "Clear the remaining unstarted work",
    });
    expect(all).toMatchObject({ deleted: 1, protectedAssignments: 1 });
    expect(await prisma.screeningAssignment.findMany({ where: { stageId: stage.id } })).toHaveLength(1);

    await expectAppError(
      screening.resetPendingAssignments(ctx(reviewer1.id), project.id, stage.id, {
        reason: "Reviewer cannot administer work",
      }),
      "FORBIDDEN",
    );
  });

  it("FULL_TEXT assignments only target citations with a TA INCLUDE result (R3)", async () => {
    const { owner, reviewer1, project } = await createProjectWithTeam();
    const ta = await makeStage(project.id, { type: "TITLE_ABSTRACT" });
    const ft = await makeStage(project.id, { type: "FULL_TEXT" });
    const included = await createTestCitation(project.id);
    const notIncluded = await createTestCitation(project.id);
    await taIncludeResult(ta.id, included.id);

    const res = await screening.createAssignments(ctx(owner.id), project.id, ft.id, {
      reviewerIds: [reviewer1.id],
      strategy: "all",
    });
    expect(res).toMatchObject({ created: 1, eligibleCitations: 1 });
    const rows = await prisma.screeningAssignment.findMany({ where: { stageId: ft.id } });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.citationId).toBe(included.id);

    // explicitly requesting the non-included citation yields nothing
    const explicit = await screening.createAssignments(ctx(owner.id), project.id, ft.id, {
      reviewerIds: [reviewer1.id],
      strategy: "all",
      citationIds: [notIncluded.id],
    });
    expect(explicit).toMatchObject({ created: 0, eligibleCitations: 0 });
  });

  // -------------------------------------------------------------------------
  // Queue
  // -------------------------------------------------------------------------

  it("queue lists my pending assignments and drops settled citations", async () => {
    const { owner, reviewer1, project } = await createProjectWithTeam();
    const stage = await makeStage(project.id, { reviewersPerCitation: 1 });
    const c1 = await createTestCitation(project.id);
    const c2 = await createTestCitation(project.id);
    await assign(stage.id, c1.id, reviewer1.id);
    await assign(stage.id, c2.id, reviewer1.id);

    const queue = await screening.getQueue(ctx(reviewer1.id), project.id, stage.id);
    expect(queue.total).toBe(2);
    expect(queue.items).toHaveLength(2);
    const item = queue.items.find((i) => i.citation.id === c1.id)!;
    expect(item.citation.title).toBe(c1.title);
    expect(item.citation.abstract).toBeTruthy();
    expect(item.myDecision).toBeNull();

    // deciding settles (single reviewer) and removes it from the queue
    await screening.createDecision(ctx(reviewer1.id), project.id, stage.id, {
      citationId: c1.id,
      decision: "INCLUDE",
    });
    const after = await screening.getQueue(ctx(reviewer1.id), project.id, stage.id);
    expect(after.total).toBe(1);
    expect(after.items[0]!.citation.id).toBe(c2.id);

    // owner (no assignments) has an empty queue
    const ownerQueue = await screening.getQueue(ctx(owner.id), project.id, stage.id);
    expect(ownerQueue.total).toBe(0);
  });

  // -------------------------------------------------------------------------
  // Decisions
  // -------------------------------------------------------------------------

  it("upserts my decision, completes the assignment, and audits with previous value", async () => {
    const { reviewer1, reviewer2, project } = await createProjectWithTeam();
    const stage = await makeStage(project.id, { reviewersPerCitation: 2 });
    const citation = await createTestCitation(project.id);
    const assignment = await assign(stage.id, citation.id, reviewer1.id);
    await assign(stage.id, citation.id, reviewer2.id);

    const first = await screening.createDecision(ctx(reviewer1.id), project.id, stage.id, {
      citationId: citation.id,
      decision: "MAYBE",
      notes: "unsure",
    });
    expect(first.decision.decision).toBe("MAYBE");
    const completed = await prisma.screeningAssignment.findUniqueOrThrow({
      where: { id: assignment.id },
    });
    expect(completed.status).toBe("COMPLETED");

    const second = await screening.createDecision(ctx(reviewer1.id), project.id, stage.id, {
      citationId: citation.id,
      decision: "INCLUDE",
      labels: ["rct"],
    });
    expect(second.decision.id).toBe(first.decision.id); // updated in place
    expect(second.decision.decision).toBe("INCLUDE");
    const count = await prisma.screeningDecision.count({
      where: { stageId: stage.id, citationId: citation.id, reviewerId: reviewer1.id },
    });
    expect(count).toBe(1);

    const updatedEvent = await prisma.auditEvent.findFirstOrThrow({
      where: {
        entityType: "ScreeningDecision",
        entityId: first.decision.id,
        action: "screening.decision.updated",
      },
    });
    expect(updatedEvent.previousValue).toMatchObject({ decision: "MAYBE", notes: "unsure" });
    expect(updatedEvent.newValue).toMatchObject({ decision: "INCLUDE" });
    await prisma.auditEvent.findFirstOrThrow({
      where: {
        entityType: "ScreeningDecision",
        entityId: first.decision.id,
        action: "screening.decision.created",
      },
    });
  });

  it("requires a live (non-VOIDED) assignment to decide", async () => {
    const { reviewer1, reviewer2, project } = await createProjectWithTeam();
    const stage = await makeStage(project.id);
    const citation = await createTestCitation(project.id);
    const a = await assign(stage.id, citation.id, reviewer1.id);

    // reviewer2 has no assignment at all
    await expectAppError(
      screening.createDecision(ctx(reviewer2.id), project.id, stage.id, {
        citationId: citation.id,
        decision: "INCLUDE",
      }),
      "FORBIDDEN",
    );
    // voided assignment blocks too
    await prisma.screeningAssignment.update({ where: { id: a.id }, data: { status: "VOIDED" } });
    await expectAppError(
      screening.createDecision(ctx(reviewer1.id), project.id, stage.id, {
        citationId: citation.id,
        decision: "INCLUDE",
      }),
      "FORBIDDEN",
    );
  });

  it("FULL_TEXT EXCLUDE requires an active FT-appropriate exclusion reason", async () => {
    const { reviewer1, reviewer2, project } = await createProjectWithTeam();
    const ta = await makeStage(project.id, { type: "TITLE_ABSTRACT" });
    const ft = await makeStage(project.id, { type: "FULL_TEXT", reviewersPerCitation: 2 });
    const citation = await createTestCitation(project.id);
    await taIncludeResult(ta.id, citation.id);
    await assign(ft.id, citation.id, reviewer1.id);
    await assign(ft.id, citation.id, reviewer2.id);

    const taOnlyReason = await makeReason(project.id, "TITLE_ABSTRACT");
    const ftReason = await makeReason(project.id, "FULL_TEXT");

    await expectAppError(
      screening.createDecision(ctx(reviewer1.id), project.id, ft.id, {
        citationId: citation.id,
        decision: "EXCLUDE",
      }),
      "VALIDATION",
    );
    await expectAppError(
      screening.createDecision(ctx(reviewer1.id), project.id, ft.id, {
        citationId: citation.id,
        decision: "EXCLUDE",
        exclusionReasonId: taOnlyReason.id,
      }),
      "VALIDATION",
    );
    const okDecision = await screening.createDecision(ctx(reviewer1.id), project.id, ft.id, {
      citationId: citation.id,
      decision: "EXCLUDE",
      exclusionReasonId: ftReason.id,
    });
    expect(okDecision.decision.exclusionReasonId).toBe(ftReason.id);
  });

  it("TA EXCLUDE may optionally carry a TA/BOTH reason but never an FT-only one", async () => {
    const { reviewer1, reviewer2, project } = await createProjectWithTeam();
    const stage = await makeStage(project.id);
    const citation = await createTestCitation(project.id);
    await assign(stage.id, citation.id, reviewer1.id);
    await assign(stage.id, citation.id, reviewer2.id);
    const bothReason = await makeReason(project.id, "BOTH");
    const ftOnlyReason = await makeReason(project.id, "FULL_TEXT");

    const noReason = await screening.createDecision(ctx(reviewer1.id), project.id, stage.id, {
      citationId: citation.id,
      decision: "EXCLUDE",
    });
    expect(noReason.decision.exclusionReasonId).toBeNull();

    const withReason = await screening.createDecision(ctx(reviewer1.id), project.id, stage.id, {
      citationId: citation.id,
      decision: "EXCLUDE",
      exclusionReasonId: bothReason.id,
    });
    expect(withReason.decision.exclusionReasonId).toBe(bothReason.id);

    await expectAppError(
      screening.createDecision(ctx(reviewer1.id), project.id, stage.id, {
        citationId: citation.id,
        decision: "EXCLUDE",
        exclusionReasonId: ftOnlyReason.id,
      }),
      "VALIDATION",
    );
  });

  it("locks decisions once a stage result exists (R5)", async () => {
    const { reviewer1, reviewer2, project } = await createProjectWithTeam();
    const stage = await makeStage(project.id, { reviewersPerCitation: 2 });
    const citation = await createTestCitation(project.id);
    await assign(stage.id, citation.id, reviewer1.id);
    await assign(stage.id, citation.id, reviewer2.id);

    for (const r of [reviewer1, reviewer2]) {
      await screening.createDecision(ctx(r.id), project.id, stage.id, {
        citationId: citation.id,
        decision: "INCLUDE",
      });
    }
    const result = await prisma.citationStageResult.findUniqueOrThrow({
      where: { stageId_citationId: { stageId: stage.id, citationId: citation.id } },
    });
    expect(result.outcome).toBe("INCLUDE");

    await expectAppError(
      screening.createDecision(ctx(reviewer1.id), project.id, stage.id, {
        citationId: citation.id,
        decision: "EXCLUDE",
      }),
      "INVALID_STATE",
    );
  });

  // -------------------------------------------------------------------------
  // Conflict matrix (R6/R7) — 2 reviewers
  // -------------------------------------------------------------------------

  describe("conflict matrix (2 reviewers)", () => {
    const cases: {
      name: string;
      decisions: [Decision, Decision];
      maybeFlag: boolean;
      expected: { outcome: Decision | null; via?: string; conflict: boolean };
    }[] = [
      {
        name: "INCLUDE+INCLUDE → CONSENSUS include, no conflict",
        decisions: ["INCLUDE", "INCLUDE"],
        maybeFlag: true,
        expected: { outcome: "INCLUDE", via: "CONSENSUS", conflict: false },
      },
      {
        name: "EXCLUDE+EXCLUDE → CONSENSUS exclude, no conflict",
        decisions: ["EXCLUDE", "EXCLUDE"],
        maybeFlag: true,
        expected: { outcome: "EXCLUDE", via: "CONSENSUS", conflict: false },
      },
      {
        name: "INCLUDE+EXCLUDE → conflict, no result",
        decisions: ["INCLUDE", "EXCLUDE"],
        maybeFlag: true,
        expected: { outcome: null, conflict: true },
      },
      {
        name: "INCLUDE+MAYBE with maybeGeneratesConflict=true → conflict",
        decisions: ["INCLUDE", "MAYBE"],
        maybeFlag: true,
        expected: { outcome: null, conflict: true },
      },
      {
        name: "INCLUDE+MAYBE with maybeGeneratesConflict=false → unsettled (no conflict, no result)",
        decisions: ["INCLUDE", "MAYBE"],
        maybeFlag: false,
        expected: { outcome: null, conflict: false },
      },
      {
        name: "MAYBE+MAYBE → conflict regardless of the flag",
        decisions: ["MAYBE", "MAYBE"],
        maybeFlag: false,
        expected: { outcome: null, conflict: true },
      },
    ];

    for (const c of cases) {
      it(c.name, async () => {
        const { reviewer1, reviewer2, project } = await createProjectWithTeam();
        const stage = await makeStage(project.id, {
          reviewersPerCitation: 2,
          maybeGeneratesConflict: c.maybeFlag,
        });
        const citation = await createTestCitation(project.id);
        await assign(stage.id, citation.id, reviewer1.id);
        await assign(stage.id, citation.id, reviewer2.id);

        for (const [i, reviewer] of [reviewer1, reviewer2].entries()) {
          await screening.createDecision(ctx(reviewer.id), project.id, stage.id, {
            citationId: citation.id,
            decision: c.decisions[i]! as "INCLUDE" | "EXCLUDE" | "MAYBE",
          });
        }

        const result = await prisma.citationStageResult.findUnique({
          where: { stageId_citationId: { stageId: stage.id, citationId: citation.id } },
        });
        const conflictRow = await prisma.screeningConflict.findUnique({
          where: { stageId_citationId: { stageId: stage.id, citationId: citation.id } },
        });

        if (c.expected.outcome) {
          expect(result?.outcome).toBe(c.expected.outcome);
          expect(result?.resolvedVia).toBe(c.expected.via);
        } else {
          expect(result).toBeNull();
        }
        if (c.expected.conflict) {
          expect(conflictRow?.status).toBe("OPEN");
          await prisma.auditEvent.findFirstOrThrow({
            where: {
              entityType: "ScreeningConflict",
              entityId: conflictRow!.id,
              action: "screening.conflict.opened",
            },
          });
        } else {
          expect(conflictRow).toBeNull();
        }
      });
    }
  });

  it("reviewersPerCitation=1 settles via SINGLE_REVIEWER", async () => {
    const { reviewer1, project } = await createProjectWithTeam();
    const stage = await makeStage(project.id, { reviewersPerCitation: 1 });
    const citation = await createTestCitation(project.id);
    await assign(stage.id, citation.id, reviewer1.id);

    const res = await screening.createDecision(ctx(reviewer1.id), project.id, stage.id, {
      citationId: citation.id,
      decision: "EXCLUDE",
    });
    expect(res.result).toMatchObject({ outcome: "EXCLUDE", resolvedVia: "SINGLE_REVIEWER" });
  });

  // -------------------------------------------------------------------------
  // Adjudication
  // -------------------------------------------------------------------------

  it("adjudication resolves the conflict, writes an ADJUDICATION result, and never touches reviewer decisions", async () => {
    const { reviewer1, reviewer2, adjudicator, project } = await createProjectWithTeam();
    const stage = await makeStage(project.id, { reviewersPerCitation: 2 });
    const citation = await createTestCitation(project.id);
    await assign(stage.id, citation.id, reviewer1.id);
    await assign(stage.id, citation.id, reviewer2.id);
    await screening.createDecision(ctx(reviewer1.id), project.id, stage.id, {
      citationId: citation.id,
      decision: "INCLUDE",
    });
    await screening.createDecision(ctx(reviewer2.id), project.id, stage.id, {
      citationId: citation.id,
      decision: "EXCLUDE",
    });
    const conflictRow = await prisma.screeningConflict.findUniqueOrThrow({
      where: { stageId_citationId: { stageId: stage.id, citationId: citation.id } },
    });

    // a plain reviewer cannot adjudicate
    await expectAppError(
      screening.adjudicateConflict(ctx(reviewer1.id), project.id, conflictRow.id, {
        finalDecision: "INCLUDE",
        reason: "I say so",
      }),
      "FORBIDDEN",
    );

    // reason is required (min 3) at the schema boundary
    expect(
      screening.adjudicateSchema.safeParse({ finalDecision: "INCLUDE", reason: "no" }).success,
    ).toBe(false);
    expect(screening.adjudicateSchema.safeParse({ finalDecision: "INCLUDE" }).success).toBe(false);
    // and MAYBE is not a legal final decision (R7)
    expect(
      screening.adjudicateSchema.safeParse({ finalDecision: "MAYBE", reason: "undecided" })
        .success,
    ).toBe(false);

    const { adjudication, conflict: resolved, result } = await screening.adjudicateConflict(
      ctx(adjudicator.id),
      project.id,
      conflictRow.id,
      { finalDecision: "INCLUDE", reason: "meets population criteria" },
    );
    expect(adjudication.adjudicatorId).toBe(adjudicator.id);
    expect(resolved.status).toBe("RESOLVED");
    expect(resolved.resolvedAt).not.toBeNull();
    expect(result).toMatchObject({ outcome: "INCLUDE", resolvedVia: "ADJUDICATION" });

    // reviewer decisions untouched
    const decisions = await prisma.screeningDecision.findMany({
      where: { stageId: stage.id, citationId: citation.id },
    });
    expect(new Set(decisions.map((d) => d.decision))).toEqual(new Set(["INCLUDE", "EXCLUDE"]));

    await prisma.auditEvent.findFirstOrThrow({
      where: {
        entityType: "ScreeningAdjudication",
        entityId: adjudication.id,
        action: "screening.conflict.adjudicated",
      },
    });
    await prisma.auditEvent.findFirstOrThrow({
      where: { entityType: "CitationStageResult", action: "screening.result.created", entityId: result.id },
    });

    // adjudicating again while resolved → INVALID_STATE
    await expectAppError(
      screening.adjudicateConflict(ctx(adjudicator.id), project.id, conflictRow.id, {
        finalDecision: "EXCLUDE",
        reason: "changed my mind",
      }),
      "INVALID_STATE",
    );
  });

  it("FT adjudication EXCLUDE requires an exclusion reason", async () => {
    const { reviewer1, reviewer2, adjudicator, project } = await createProjectWithTeam();
    const ta = await makeStage(project.id, { type: "TITLE_ABSTRACT" });
    const ft = await makeStage(project.id, { type: "FULL_TEXT", reviewersPerCitation: 2 });
    const citation = await createTestCitation(project.id);
    await taIncludeResult(ta.id, citation.id);
    await assign(ft.id, citation.id, reviewer1.id);
    await assign(ft.id, citation.id, reviewer2.id);
    const ftReason = await makeReason(project.id, "FULL_TEXT");
    await screening.createDecision(ctx(reviewer1.id), project.id, ft.id, {
      citationId: citation.id,
      decision: "INCLUDE",
    });
    await screening.createDecision(ctx(reviewer2.id), project.id, ft.id, {
      citationId: citation.id,
      decision: "EXCLUDE",
      exclusionReasonId: ftReason.id,
    });
    const conflictRow = await prisma.screeningConflict.findUniqueOrThrow({
      where: { stageId_citationId: { stageId: ft.id, citationId: citation.id } },
    });

    await expectAppError(
      screening.adjudicateConflict(ctx(adjudicator.id), project.id, conflictRow.id, {
        finalDecision: "EXCLUDE",
        reason: "wrong comparator",
      }),
      "VALIDATION",
    );
    const { result } = await screening.adjudicateConflict(ctx(adjudicator.id), project.id, conflictRow.id, {
      finalDecision: "EXCLUDE",
      exclusionReasonId: ftReason.id,
      reason: "wrong comparator",
    });
    expect(result.outcome).toBe("EXCLUDE");
    // EXCLUDE at FT creates no study
    const links = await prisma.studyReportLink.findMany({ where: { citationId: citation.id } });
    expect(links).toHaveLength(0);
  });

  // -------------------------------------------------------------------------
  // FT INCLUDE → study auto-creation (R14)
  // -------------------------------------------------------------------------

  it("FT INCLUDE via consensus auto-creates a study with a primary report link", async () => {
    const { reviewer1, reviewer2, project } = await createProjectWithTeam();
    const ta = await makeStage(project.id, { type: "TITLE_ABSTRACT" });
    const ft = await makeStage(project.id, { type: "FULL_TEXT", reviewersPerCitation: 2 });
    const citation = await createTestCitation(project.id, { year: 2019 });
    await taIncludeResult(ta.id, citation.id);
    await assign(ft.id, citation.id, reviewer1.id);
    await assign(ft.id, citation.id, reviewer2.id);

    for (const r of [reviewer1, reviewer2]) {
      await screening.createDecision(ctx(r.id), project.id, ft.id, {
        citationId: citation.id,
        decision: "INCLUDE",
      });
    }

    const link = await prisma.studyReportLink.findFirstOrThrow({
      where: { citationId: citation.id },
      include: { study: true },
    });
    expect(link.isPrimaryReport).toBe(true);
    expect(link.study.label).toBe("Smith 2019"); // first author family + year
    expect(link.study.projectId).toBe(project.id);
    await prisma.auditEvent.findFirstOrThrow({
      where: { entityType: "Study", entityId: link.study.id, action: "study.created" },
    });
    await prisma.auditEvent.findFirstOrThrow({
      where: { entityType: "StudyReportLink", entityId: link.id, action: "study.report_linked" },
    });
  });

  it("FT INCLUDE via adjudication auto-creates a study; already-linked citations are skipped", async () => {
    const { owner, reviewer1, reviewer2, adjudicator, project } = await createProjectWithTeam();
    const ta = await makeStage(project.id, { type: "TITLE_ABSTRACT" });
    const ft = await makeStage(project.id, { type: "FULL_TEXT", reviewersPerCitation: 2 });
    const citation = await createTestCitation(project.id);
    await taIncludeResult(ta.id, citation.id);
    await assign(ft.id, citation.id, reviewer1.id);
    await assign(ft.id, citation.id, reviewer2.id);
    const ftReason = await makeReason(project.id, "FULL_TEXT");
    await screening.createDecision(ctx(reviewer1.id), project.id, ft.id, {
      citationId: citation.id,
      decision: "INCLUDE",
    });
    await screening.createDecision(ctx(reviewer2.id), project.id, ft.id, {
      citationId: citation.id,
      decision: "EXCLUDE",
      exclusionReasonId: ftReason.id,
    });
    const conflictRow = await prisma.screeningConflict.findUniqueOrThrow({
      where: { stageId_citationId: { stageId: ft.id, citationId: citation.id } },
    });

    await screening.adjudicateConflict(ctx(adjudicator.id), project.id, conflictRow.id, {
      finalDecision: "INCLUDE",
      reason: "population fits after full read",
    });
    const links = await prisma.studyReportLink.findMany({ where: { citationId: citation.id } });
    expect(links).toHaveLength(1);
    expect(links[0]!.isPrimaryReport).toBe(true);

    // idempotent: a second auto-create for the same citation is a no-op (R18 soft rule)
    const again = await studies.autoCreateForCitation(
      prisma,
      ctx(owner.id),
      project.id,
      citation.id,
    );
    expect(again).toBeNull();
    expect(await prisma.studyReportLink.count({ where: { citationId: citation.id } })).toBe(1);
  });

  // -------------------------------------------------------------------------
  // Reopen (R5)
  // -------------------------------------------------------------------------

  it("reopen deletes the result (audited), unlocks decisions, and re-runs conflict detection", async () => {
    const { owner, reviewer1, reviewer2, project } = await createProjectWithTeam();
    const stage = await makeStage(project.id, { reviewersPerCitation: 2 });
    const citation = await createTestCitation(project.id);
    await assign(stage.id, citation.id, reviewer1.id);
    await assign(stage.id, citation.id, reviewer2.id);
    for (const r of [reviewer1, reviewer2]) {
      await screening.createDecision(ctx(r.id), project.id, stage.id, {
        citationId: citation.id,
        decision: "INCLUDE",
      });
    }
    const result = await prisma.citationStageResult.findUniqueOrThrow({
      where: { stageId_citationId: { stageId: stage.id, citationId: citation.id } },
    });

    // a plain reviewer may not reopen
    await expectAppError(
      screening.reopenCitation(ctx(reviewer1.id), project.id, citation.id, {
        stageType: "TITLE_ABSTRACT",
        reason: "let me change it",
      }),
      "FORBIDDEN",
    );

    await screening.reopenCitation(ctx(owner.id), project.id, citation.id, {
      stageType: "TITLE_ABSTRACT",
      reason: "screened against outdated criteria",
    });
    expect(
      await prisma.citationStageResult.findUnique({
        where: { stageId_citationId: { stageId: stage.id, citationId: citation.id } },
      }),
    ).toBeNull();
    const reopenEvent = await prisma.auditEvent.findFirstOrThrow({
      where: {
        entityType: "CitationStageResult",
        entityId: result.id,
        action: "screening.result.reopened",
      },
    });
    expect(reopenEvent.previousValue).toMatchObject({ outcome: "INCLUDE" });
    expect(reopenEvent.reason).toBe("screened against outdated criteria");

    // reopening again with no result → INVALID_STATE
    await expectAppError(
      screening.reopenCitation(ctx(owner.id), project.id, citation.id, {
        stageType: "TITLE_ABSTRACT",
        reason: "double reopen",
      }),
      "INVALID_STATE",
    );

    // decisions are editable again and re-evaluation opens a conflict on disagreement
    await screening.createDecision(ctx(reviewer1.id), project.id, stage.id, {
      citationId: citation.id,
      decision: "EXCLUDE",
    });
    const conflictRow = await prisma.screeningConflict.findUniqueOrThrow({
      where: { stageId_citationId: { stageId: stage.id, citationId: citation.id } },
    });
    expect(conflictRow.status).toBe("OPEN");
  });

  it("reopen voids a RESOLVED conflict; re-adjudication updates the 1:1 row in place", async () => {
    const { owner, reviewer1, reviewer2, adjudicator, project } = await createProjectWithTeam();
    const stage = await makeStage(project.id, { reviewersPerCitation: 2 });
    const citation = await createTestCitation(project.id);
    await assign(stage.id, citation.id, reviewer1.id);
    await assign(stage.id, citation.id, reviewer2.id);
    await screening.createDecision(ctx(reviewer1.id), project.id, stage.id, {
      citationId: citation.id,
      decision: "INCLUDE",
    });
    await screening.createDecision(ctx(reviewer2.id), project.id, stage.id, {
      citationId: citation.id,
      decision: "EXCLUDE",
    });
    const conflictRow = await prisma.screeningConflict.findUniqueOrThrow({
      where: { stageId_citationId: { stageId: stage.id, citationId: citation.id } },
    });
    const first = await screening.adjudicateConflict(ctx(adjudicator.id), project.id, conflictRow.id, {
      finalDecision: "INCLUDE",
      reason: "initial call",
    });

    await screening.reopenCitation(ctx(owner.id), project.id, citation.id, {
      stageType: "TITLE_ABSTRACT",
      reason: "adjudicated too hastily",
    });
    const voided = await prisma.screeningConflict.findUniqueOrThrow({
      where: { id: conflictRow.id },
    });
    expect(voided.status).toBe("VOIDED");

    // disagreement recurs (reviewer re-affirms EXCLUDE) → the conflict flips back to OPEN
    await screening.createDecision(ctx(reviewer2.id), project.id, stage.id, {
      citationId: citation.id,
      decision: "EXCLUDE",
      notes: "still excluded",
    });
    const reopened = await prisma.screeningConflict.findUniqueOrThrow({
      where: { id: conflictRow.id },
    });
    expect(reopened.status).toBe("OPEN");
    await prisma.auditEvent.findFirstOrThrow({
      where: {
        entityType: "ScreeningConflict",
        entityId: conflictRow.id,
        action: "screening.conflict.reopened",
      },
    });

    // re-adjudication updates the same adjudication row in place with previous value audited
    const second = await screening.adjudicateConflict(ctx(adjudicator.id), project.id, conflictRow.id, {
      finalDecision: "EXCLUDE",
      reason: "excluded on reflection",
    });
    expect(second.adjudication.id).toBe(first.adjudication.id);
    expect(second.adjudication.finalDecision).toBe("EXCLUDE");
    const adjEvents = await prisma.auditEvent.findMany({
      where: {
        entityType: "ScreeningAdjudication",
        entityId: first.adjudication.id,
        action: "screening.conflict.adjudicated",
      },
      orderBy: { createdAt: "asc" },
    });
    expect(adjEvents).toHaveLength(2);
    expect(adjEvents[1]!.previousValue).toMatchObject({ finalDecision: "INCLUDE" });
    const finalResult = await prisma.citationStageResult.findUniqueOrThrow({
      where: { stageId_citationId: { stageId: stage.id, citationId: citation.id } },
    });
    expect(finalResult).toMatchObject({ outcome: "EXCLUDE", resolvedVia: "ADJUDICATION" });
  });

  // -------------------------------------------------------------------------
  // Studies: manual create / link / unlink (R14, R18)
  // -------------------------------------------------------------------------

  it("manual study create/link/unlink enforces the one-study-per-report rule", async () => {
    const { owner, reviewer1, project } = await createProjectWithTeam();
    const c1 = await createTestCitation(project.id);
    const c2 = await createTestCitation(project.id);

    // reviewers cannot manage studies
    await expectAppError(
      studies.createStudy(ctx(reviewer1.id), project.id, { label: "Nope 2020" }),
      "FORBIDDEN",
    );

    const study = await studies.createStudy(ctx(owner.id), project.id, {
      label: "Smith 2020",
      citationId: c1.id,
    });
    expect(study.reportLinks).toHaveLength(1);
    expect(study.reportLinks[0]!.isPrimaryReport).toBe(true);

    // the same citation cannot seed a second study (R18 soft rule)
    await expectAppError(
      studies.createStudy(ctx(owner.id), project.id, { label: "Dup 2020", citationId: c1.id }),
      "CONFLICT",
    );

    // link a companion report
    const link = await studies.linkReport(ctx(owner.id), project.id, study.id, {
      citationId: c2.id,
    });
    expect(link.isPrimaryReport).toBe(false);
    // ... and it cannot be linked to another study while linked here
    const other = await studies.createStudy(ctx(owner.id), project.id, { label: "Other 2021" });
    await expectAppError(
      studies.linkReport(ctx(owner.id), project.id, other.id, { citationId: c2.id }),
      "CONFLICT",
    );

    // listing shows links + counts
    const listed = await studies.listStudies(ctx(owner.id), project.id);
    const mine = listed.find((s) => s.id === study.id)!;
    expect(mine.reportLinks).toHaveLength(2);
    expect(mine._count).toMatchObject({ extractionForms: 0, robAssessments: 0 });

    // update + audit with previous
    const updated = await studies.updateStudy(ctx(owner.id), project.id, study.id, {
      label: "Smith 2020 (RCT)",
      inQuantitativeSynthesis: true,
    });
    expect(updated.inQuantitativeSynthesis).toBe(true);
    const updateEvent = await prisma.auditEvent.findFirstOrThrow({
      where: { entityType: "Study", entityId: study.id, action: "study.updated" },
    });
    expect(updateEvent.previousValue).toMatchObject({
      label: "Smith 2020",
      inQuantitativeSynthesis: false,
    });

    // unlink the companion report
    await studies.unlinkReport(ctx(owner.id), project.id, study.id, c2.id);
    expect(await prisma.studyReportLink.count({ where: { studyId: study.id } })).toBe(1);
    await prisma.auditEvent.findFirstOrThrow({
      where: { action: "study.report_unlinked", entityType: "StudyReportLink" },
    });

    // refuse to remove the LAST report of a study that has extraction forms
    const template = await prisma.extractionTemplate.create({
      data: { projectId: project.id, name: uniq("tpl"), createdById: owner.id },
    });
    await prisma.extractionForm.create({
      data: { templateId: template.id, studyId: study.id, extractorId: owner.id },
    });
    await expectAppError(
      studies.unlinkReport(ctx(owner.id), project.id, study.id, c1.id),
      "INVALID_STATE",
    );
  });

  it("tenant scoping: foreign project's stage, citation, conflict, and study are 404", async () => {
    const teamA = await createProjectWithTeam();
    const teamB = await createProjectWithTeam();
    const stageA = await makeStage(teamA.project.id);
    const citationA = await createTestCitation(teamA.project.id);

    // stage from another project
    await expectAppError(
      screening.updateStage(ctx(teamB.owner.id), teamB.project.id, stageA.id, { blinded: false }),
      "NOT_FOUND",
    );
    // citation from another project
    const stageB = await makeStage(teamB.project.id);
    await assign(stageB.id, citationA.id, teamB.reviewer1.id); // deliberately wrong wiring
    await expectAppError(
      screening.createDecision(ctx(teamB.reviewer1.id), teamB.project.id, stageB.id, {
        citationId: citationA.id,
        decision: "INCLUDE",
      }),
      "NOT_FOUND",
    );
    // study from another project
    const studyA = await studies.createStudy(ctx(teamA.owner.id), teamA.project.id, {
      label: "A study",
    });
    await expectAppError(
      studies.updateStudy(ctx(teamB.owner.id), teamB.project.id, studyA.id, { label: "steal" }),
      "NOT_FOUND",
    );
  });
});
