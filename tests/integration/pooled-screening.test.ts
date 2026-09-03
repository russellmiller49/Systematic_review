import { beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/server/db";
import { AppError } from "@/server/errors";
import * as projects from "@/server/services/projects";
import * as pooled from "@/server/services/screening/pooled";
import { resetDb } from "../db-utils";
import {
  addOrgMember,
  addProjectMember,
  createTestCitation,
  createTestOrg,
  createTestProject,
  createTestUser,
} from "../factories";

const ctx = (userId: string) => ({ userId });

async function expectAppError(promise: Promise<unknown>, code: string) {
  try {
    await promise;
    expect.fail(`expected AppError(${code}) but call succeeded`);
  } catch (error) {
    if (!(error instanceof AppError)) throw error;
    expect(error.code).toBe(code);
  }
}

async function createFamily() {
  const owner = await createTestUser({ name: "Guideline Owner" });
  const reviewer1 = await createTestUser({ name: "Pooled Reviewer One" });
  const reviewer2 = await createTestUser({ name: "Pooled Reviewer Two" });
  const org = await createTestOrg(owner.id);
  await addOrgMember(org.id, reviewer1.id);
  await addOrgMember(org.id, reviewer2.id);
  const guideline = await projects.createProject(ctx(owner.id), org.id, {
    title: "Pooled Screening Guideline",
    reviewType: "GUIDELINE_EVIDENCE_REVIEW",
    isGuideline: true,
    reviewersPerCitation: 2,
  });
  await addProjectMember(guideline.id, reviewer1.id, ["REVIEWER"]);
  await addProjectMember(guideline.id, reviewer2.id, ["REVIEWER"]);
  const pico1 = await projects.createSubProject(ctx(owner.id), guideline.id, {
    title: "PICO 1",
    researchQuestion: "In population one, does intervention one improve outcome one?",
  });
  const pico2 = await projects.createSubProject(ctx(owner.id), guideline.id, {
    title: "PICO 2",
    researchQuestion: "In population two, does intervention two improve outcome two?",
  });
  const pico3 = await projects.createSubProject(ctx(owner.id), guideline.id, {
    title: "PICO 3",
    researchQuestion: "In population three, does intervention three improve outcome three?",
  });
  return { owner, reviewer1, reviewer2, org, guideline, pico1, pico2, pico3 };
}

describe("guideline pooled abstract screening", () => {
  beforeAll(async () => {
    await resetDb();
  });

  it("groups overlapping abstracts, assigns them consistently, and propagates one decision", async () => {
    const { owner, reviewer1, reviewer2, guideline, pico1, pico2, pico3 } = await createFamily();
    const shared1 = await createTestCitation(pico1.id, {
      title: "Shared report title in PICO one",
      doi: "10.1000/shared-report",
      abstract: "The longer shared abstract is used as the representative card.",
    });
    const shared2 = await createTestCitation(pico2.id, {
      title: "A title variant in PICO two",
      doi: "10.1000/shared-report",
      abstract: "Short shared abstract.",
    });
    await createTestCitation(pico3.id, {
      title: "Unique report in PICO three",
      pmid: "30001",
    });
    const projectIds = [pico1.id, pico2.id, pico3.id];

    const assignment = await pooled.createPooledAssignments(ctx(owner.id), guideline.id, {
      projectIds,
      reviewerIds: [reviewer1.id, reviewer2.id],
      strategy: "all",
    });
    expect(assignment).toMatchObject({
      created: 6,
      skippedExisting: 0,
      eligibleAbstracts: 2,
      linkedCitationRecords: 3,
    });

    const queue = await pooled.getPooledQueue(ctx(reviewer1.id), guideline.id, { projectIds });
    expect(queue.summary).toMatchObject({
      pooledAbstracts: 2,
      linkedCitationRecords: 3,
      overlaps: 1,
      ready: 2,
      needsAssignment: 0,
    });
    const sharedItem = queue.items.find((item) => item.citationIds.includes(shared1.id));
    expect(sharedItem).toBeDefined();
    expect(sharedItem!.citation.abstract).toContain("longer shared abstract");
    expect(sharedItem!.picos.map((pico) => pico.picoNumber)).toEqual([1, 2]);

    const first = await pooled.createPooledDecision(ctx(reviewer1.id), guideline.id, {
      projectIds,
      citationIds: sharedItem!.citationIds,
      decision: "INCLUDE",
      notes: "One overall pooled note",
    });
    expect(first).toMatchObject({
      decision: "INCLUDE",
      appliedToCitationRecords: 2,
      appliedToPicos: 2,
    });
    expect(first.results).toEqual([null, null]);

    const firstDecisions = await prisma.screeningDecision.findMany({
      where: { reviewerId: reviewer1.id, citationId: { in: [shared1.id, shared2.id] } },
      orderBy: { citationId: "asc" },
    });
    expect(firstDecisions).toHaveLength(2);
    expect(firstDecisions.every((decision) => decision.decision === "INCLUDE")).toBe(true);
    expect(firstDecisions.every((decision) => decision.notes === "One overall pooled note")).toBe(true);

    const afterFirst = await pooled.getPooledQueue(ctx(reviewer1.id), guideline.id, { projectIds });
    expect(afterFirst.summary).toMatchObject({ ready: 1, awaitingOtherReviewers: 1 });

    const second = await pooled.createPooledDecision(ctx(reviewer2.id), guideline.id, {
      projectIds,
      citationIds: sharedItem!.citationIds,
      decision: "INCLUDE",
    });
    expect(second.results.every((result) => result?.outcome === "INCLUDE")).toBe(true);
    const results = await prisma.citationStageResult.findMany({
      where: { citationId: { in: [shared1.id, shared2.id] } },
    });
    expect(results).toHaveLength(2);
    expect(results.every((result) => result.outcome === "INCLUDE")).toBe(true);

    const events = await prisma.auditEvent.findMany({
      where: {
        entityType: "ScreeningDecision",
        entityId: { in: firstDecisions.map((decision) => decision.id) },
      },
    });
    expect(events).toHaveLength(2);
    expect(events.every((event) =>
      (event.metadata as { pooledGuidelineId?: string } | null)?.pooledGuidelineId === guideline.id,
    )).toBe(true);
  });

  it("maps one common exclusion subgroup to each PICO's local reason row", async () => {
    const { owner, reviewer1, reviewer2, guideline, pico1, pico2 } = await createFamily();
    const citation1 = await createTestCitation(pico1.id, {
      title: "Wrong population report",
      pmid: "40001",
    });
    const citation2 = await createTestCitation(pico2.id, {
      title: "Wrong population report variant",
      pmid: "40001",
    });
    const projectIds = [pico1.id, pico2.id];
    await pooled.createPooledAssignments(ctx(owner.id), guideline.id, {
      projectIds,
      reviewerIds: [reviewer1.id, reviewer2.id],
      strategy: "all",
    });

    for (const reviewer of [reviewer1, reviewer2]) {
      await pooled.createPooledDecision(ctx(reviewer.id), guideline.id, {
        projectIds,
        citationIds: [citation1.id, citation2.id],
        decision: "EXCLUDE",
        exclusionReasonLabel: "Wrong population",
      });
    }

    const decisions = await prisma.screeningDecision.findMany({
      where: { citationId: { in: [citation1.id, citation2.id] } },
      include: { exclusionReason: true },
    });
    expect(decisions).toHaveLength(4);
    expect(decisions.every((decision) => decision.exclusionReason?.label === "Wrong population")).toBe(true);
    expect(new Set(decisions.map((decision) => decision.exclusionReasonId)).size).toBe(2);
    const results = await prisma.citationStageResult.findMany({
      where: { citationId: { in: [citation1.id, citation2.id] } },
    });
    expect(results.every((result) => result.outcome === "EXCLUDE")).toBe(true);
  });

  it("rolls the whole pooled decision back when one linked PICO assignment is missing", async () => {
    const { owner, reviewer1, guideline, pico1, pico2 } = await createFamily();
    const citation1 = await createTestCitation(pico1.id, {
      title: "Atomic pooled report",
      doi: "10.1000/atomic-pool",
    });
    const citation2 = await createTestCitation(pico2.id, {
      title: "Atomic pooled report variant",
      doi: "10.1000/atomic-pool",
    });
    const projectIds = [pico1.id, pico2.id];
    await pooled.createPooledAssignments(ctx(owner.id), guideline.id, {
      projectIds,
      reviewerIds: [reviewer1.id],
      strategy: "all",
    });
    const pico2Stage = await prisma.screeningStage.findUniqueOrThrow({
      where: { projectId_type: { projectId: pico2.id, type: "TITLE_ABSTRACT" } },
    });
    await prisma.screeningAssignment.delete({
      where: {
        stageId_citationId_reviewerId: {
          stageId: pico2Stage.id,
          citationId: citation2.id,
          reviewerId: reviewer1.id,
        },
      },
    });

    const queue = await pooled.getPooledQueue(ctx(reviewer1.id), guideline.id, { projectIds });
    expect(queue.summary).toMatchObject({ ready: 0, needsAssignment: 1 });
    await expectAppError(
      pooled.createPooledDecision(ctx(reviewer1.id), guideline.id, {
        projectIds,
        citationIds: [citation1.id, citation2.id],
        decision: "INCLUDE",
      }),
      "FORBIDDEN",
    );
    expect(
      await prisma.screeningDecision.count({
        where: { citationId: { in: [citation1.id, citation2.id] }, reviewerId: reviewer1.id },
      }),
    ).toBe(0);
  });

  it("rejects projects outside the selected guideline family", async () => {
    const { reviewer1, org, guideline, pico1 } = await createFamily();
    const standalone = await createTestProject(org.id, reviewer1.id);
    await expectAppError(
      pooled.getPooledQueue(ctx(reviewer1.id), guideline.id, {
        projectIds: [pico1.id, standalone.id],
      }),
      "VALIDATION",
    );
  });
});
