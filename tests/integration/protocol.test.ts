// Protocol builder, versions, amendments, exclusion reasons — services against real Postgres.
// Run with: TEST_DATABASE_URL=postgresql://srb:srb@localhost:5442/srb_test_protocol \
//   npx vitest run --config vitest.integration.config.ts tests/integration/protocol.test.ts
import { beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/server/db";
import { AppError } from "@/server/errors";
import * as protocols from "@/server/services/protocols";
import { resetDb } from "../db-utils";
import { createProjectWithTeam, createTestCitation, uniq } from "../factories";

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

// Local precondition helpers (screening domain belongs to another agent — direct prisma writes).
async function ensureStage(projectId: string, type: "TITLE_ABSTRACT" | "FULL_TEXT" = "TITLE_ABSTRACT") {
  const existing = await prisma.screeningStage.findFirst({ where: { projectId, type } });
  return existing ?? prisma.screeningStage.create({ data: { projectId, type } });
}

// screeningHasBegun := any ScreeningDecision exists for any stage of the project.
async function beginScreening(
  projectId: string,
  reviewerId: string,
  overrides: { decision?: "INCLUDE" | "EXCLUDE" | "MAYBE"; exclusionReasonId?: string } = {},
) {
  const stage = await ensureStage(projectId);
  const citation = await createTestCitation(projectId);
  const decision = await prisma.screeningDecision.create({
    data: {
      stageId: stage.id,
      citationId: citation.id,
      reviewerId,
      decision: overrides.decision ?? "INCLUDE",
      exclusionReasonId: overrides.exclusionReasonId ?? null,
    },
  });
  return { stage, citation, decision };
}

describe("protocols service", () => {
  beforeAll(async () => {
    await resetDb();
  });

  it("updates the protocol before screening: no version/amendment, field-level audit", async () => {
    const { owner, project } = await createProjectWithTeam();

    const result = await protocols.updateProtocol(ctx(owner.id), project.id, {
      background: "Initial background",
      databases: ["PubMed", "Embase"],
      dateRestrictionFrom: 2010,
    });

    expect(result.protocol.background).toBe("Initial background");
    expect(result.protocol.databases).toEqual(["PubMed", "Embase"]);
    expect(result.version).toBeNull();
    expect(result.amendment).toBeNull();

    const protocolId = result.protocol.id;
    expect(await prisma.protocolVersion.count({ where: { protocolId } })).toBe(0);
    expect(await prisma.protocolAmendment.count({ where: { protocolId } })).toBe(0);

    const event = await prisma.auditEvent.findFirstOrThrow({
      where: { entityType: "Protocol", entityId: protocolId, action: "protocol.updated" },
    });
    expect(event.userId).toBe(owner.id);
    expect(event.previousValue).toMatchObject({ background: null });
    expect(event.newValue).toMatchObject({
      background: "Initial background",
      dateRestrictionFrom: 2010,
    });
  });

  it("after screening begins: update without reason → 422, with reason → version+amendment numbered correctly", async () => {
    const { owner, reviewer1, project } = await createProjectWithTeam();

    // publish v1, then start screening
    const v1 = await protocols.publishProtocol(ctx(owner.id), project.id);
    expect(v1.versionNumber).toBe(1);
    await beginScreening(project.id, reviewer1.id);

    await expectAppError(
      protocols.updateProtocol(ctx(owner.id), project.id, { background: "Changed" }),
      "INVALID_STATE",
    );

    const result = await protocols.updateProtocol(ctx(owner.id), project.id, {
      background: "Changed after screening",
      amendmentReason: "Reviewer feedback on scope",
      amendmentDescription: "Broadened background section",
    });

    expect(result.version?.versionNumber).toBe(2);
    expect(result.amendment).toMatchObject({
      fromVersion: 1,
      toVersion: 2,
      reason: "Reviewer feedback on scope",
      description: "Broadened background section",
      createdById: owner.id,
    });

    // snapshot is taken AFTER the change
    const snapshot = result.version?.snapshot as { protocol: { background: string } };
    expect(snapshot.protocol.background).toBe("Changed after screening");

    const amended = await prisma.auditEvent.findFirstOrThrow({
      where: {
        projectId: project.id,
        entityType: "ProtocolAmendment",
        action: "protocol.amended",
      },
    });
    expect(amended.reason).toBe("Reviewer feedback on scope");
    expect(amended.newValue).toMatchObject({ fromVersion: 1, toVersion: 2 });

    const updated = await prisma.auditEvent.findFirstOrThrow({
      where: {
        projectId: project.id,
        entityType: "Protocol",
        action: "protocol.updated",
        reason: "Reviewer feedback on scope",
      },
    });
    expect(updated.previousValue).toMatchObject({ background: null });
    expect(updated.newValue).toMatchObject({ background: "Changed after screening" });

    // a second amendment keeps counting up
    const again = await protocols.updateProtocol(ctx(owner.id), project.id, {
      setting: "ICU",
      amendmentReason: "Clarify setting",
    });
    expect(again.version?.versionNumber).toBe(3);
    expect(again.amendment).toMatchObject({ fromVersion: 2, toVersion: 3 });
  });

  it("no-op update (no changed fields) creates nothing even after screening began", async () => {
    const { owner, reviewer1, project } = await createProjectWithTeam();
    await protocols.updateProtocol(ctx(owner.id), project.id, { setting: "Hospital" });
    await beginScreening(project.id, reviewer1.id);

    const result = await protocols.updateProtocol(ctx(owner.id), project.id, {
      setting: "Hospital", // unchanged
      amendmentReason: "Should be a no-op",
    });
    expect(result.version).toBeNull();
    expect(result.amendment).toBeNull();
    expect(
      await prisma.protocolVersion.count({ where: { protocolId: result.protocol.id } }),
    ).toBe(0);
  });

  it("criteria CRUD obeys the amendment rule and audits previous values", async () => {
    const { owner, reviewer1, project } = await createProjectWithTeam();

    // before screening — plain CRUD, no versions
    const criterion = await protocols.createCriterion(ctx(owner.id), project.id, {
      type: "INCLUSION",
      text: "Adults over 18",
      category: "population",
    });
    const updatedPre = await protocols.updateCriterion(ctx(owner.id), project.id, criterion.id, {
      text: "Adults over 18 years",
    });
    expect(updatedPre.text).toBe("Adults over 18 years");
    expect(
      await prisma.protocolVersion.count({ where: { protocolId: criterion.protocolId } }),
    ).toBe(0);

    const preUpdateEvent = await prisma.auditEvent.findFirstOrThrow({
      where: {
        entityType: "EligibilityCriterion",
        entityId: criterion.id,
        action: "protocol.criterion.updated",
      },
    });
    expect(preUpdateEvent.previousValue).toMatchObject({ text: "Adults over 18" });
    expect(preUpdateEvent.newValue).toMatchObject({ text: "Adults over 18 years" });

    // screening begins — mutations now need a reason
    await beginScreening(project.id, reviewer1.id);

    await expectAppError(
      protocols.updateCriterion(ctx(owner.id), project.id, criterion.id, { text: "Nope" }),
      "INVALID_STATE",
    );
    await expectAppError(
      protocols.createCriterion(ctx(owner.id), project.id, {
        type: "EXCLUSION",
        text: "Animal studies",
      }),
      "INVALID_STATE",
    );
    await expectAppError(
      protocols.deleteCriterion(ctx(owner.id), project.id, criterion.id, {}),
      "INVALID_STATE",
    );

    const updatedPost = await protocols.updateCriterion(ctx(owner.id), project.id, criterion.id, {
      text: "Adults 18-65 years",
      amendmentReason: "Panel narrowed the age range",
    });
    expect(updatedPost.text).toBe("Adults 18-65 years");
    expect(
      await prisma.protocolVersion.count({ where: { protocolId: criterion.protocolId } }),
    ).toBe(1);
    const amendment1 = await prisma.protocolAmendment.findFirstOrThrow({
      where: { protocolId: criterion.protocolId },
    });
    expect(amendment1).toMatchObject({ fromVersion: 0, toVersion: 1 });

    await protocols.deleteCriterion(ctx(owner.id), project.id, criterion.id, {
      amendmentReason: "Criterion superseded",
    });
    expect(
      await prisma.eligibilityCriterion.findUnique({ where: { id: criterion.id } }),
    ).toBeNull();
    expect(
      await prisma.protocolVersion.count({ where: { protocolId: criterion.protocolId } }),
    ).toBe(2);

    const deleteEvent = await prisma.auditEvent.findFirstOrThrow({
      where: {
        entityType: "EligibilityCriterion",
        entityId: criterion.id,
        action: "protocol.criterion.deleted",
      },
    });
    expect(deleteEvent.previousValue).toMatchObject({ text: "Adults 18-65 years" });
    expect(deleteEvent.reason).toBe("Criterion superseded");
  });

  it("PICO and outcome CRUD audit create/update/delete with previous values", async () => {
    const { owner, project } = await createProjectWithTeam();

    const pico = await protocols.createPico(ctx(owner.id), project.id, {
      question: "Does X improve Y in adults?",
      population: "Adults",
    });
    await protocols.updatePico(ctx(owner.id), project.id, pico.id, { population: "Adults 18+" });
    const picoUpdate = await prisma.auditEvent.findFirstOrThrow({
      where: { entityType: "PICOQuestion", entityId: pico.id, action: "protocol.pico.updated" },
    });
    expect(picoUpdate.previousValue).toMatchObject({ population: "Adults" });
    expect(picoUpdate.newValue).toMatchObject({ population: "Adults 18+" });

    await protocols.deletePico(ctx(owner.id), project.id, pico.id, {});
    expect(await prisma.pICOQuestion.findUnique({ where: { id: pico.id } })).toBeNull();
    const picoDelete = await prisma.auditEvent.findFirstOrThrow({
      where: { entityType: "PICOQuestion", entityId: pico.id, action: "protocol.pico.deleted" },
    });
    expect(picoDelete.previousValue).toMatchObject({ question: "Does X improve Y in adults?" });

    const outcome = await protocols.createOutcome(ctx(owner.id), project.id, {
      name: "Mortality",
      type: "PRIMARY",
      measure: "RR",
    });
    await protocols.updateOutcome(ctx(owner.id), project.id, outcome.id, { measure: "OR" });
    const outcomeUpdate = await prisma.auditEvent.findFirstOrThrow({
      where: {
        entityType: "OutcomeDefinition",
        entityId: outcome.id,
        action: "protocol.outcome.updated",
      },
    });
    expect(outcomeUpdate.previousValue).toMatchObject({ measure: "RR" });
    expect(outcomeUpdate.newValue).toMatchObject({ measure: "OR" });

    await protocols.deleteOutcome(ctx(owner.id), project.id, outcome.id, {});
    expect(await prisma.outcomeDefinition.findUnique({ where: { id: outcome.id } })).toBeNull();

    // getProtocol returns children + latest version number
    const full = await protocols.getProtocol(ctx(owner.id), project.id);
    expect(full.picoQuestions).toEqual([]);
    expect(full.latestVersionNumber).toBe(0);
  });

  it("child by-id loads are tenant-scoped (404 across projects)", async () => {
    const teamA = await createProjectWithTeam();
    const teamB = await createProjectWithTeam();
    const criterion = await protocols.createCriterion(ctx(teamA.owner.id), teamA.project.id, {
      type: "INCLUSION",
      text: "RCTs only",
    });
    // owner of project B cannot touch project A's criterion via their own project
    await expectAppError(
      protocols.updateCriterion(ctx(teamB.owner.id), teamB.project.id, criterion.id, {
        text: "hijack",
      }),
      "NOT_FOUND",
    );
    await expectAppError(
      protocols.deleteCriterion(ctx(teamB.owner.id), teamB.project.id, criterion.id, {}),
      "NOT_FOUND",
    );
  });

  it("publish freezes a snapshot with criteria, children, stage configs and exclusion reasons", async () => {
    const { owner, project } = await createProjectWithTeam();
    await protocols.updateProtocol(ctx(owner.id), project.id, { reviewQuestion: "X vs Y?" });
    await protocols.createCriterion(ctx(owner.id), project.id, {
      type: "INCLUSION",
      text: "Randomized controlled trials",
    });
    await protocols.createPico(ctx(owner.id), project.id, { question: "P I C O?" });
    await protocols.createOutcome(ctx(owner.id), project.id, { name: "Mortality" });
    await protocols.createExclusionReason(ctx(owner.id), project.id, {
      label: "Wrong population",
      stage: "TITLE_ABSTRACT",
    });
    const stage = await ensureStage(project.id);

    const version = await protocols.publishProtocol(ctx(owner.id), project.id);
    expect(version.versionNumber).toBe(1);

    const snapshot = version.snapshot as {
      protocol: {
        reviewQuestion: string;
        criteria: { text: string }[];
        picoQuestions: { question: string }[];
        outcomes: { name: string }[];
      };
      screeningStages: { id: string; type: string; reviewersPerCitation: number; blinded: boolean }[];
      exclusionReasons: { label: string; stage: string }[];
    };
    expect(snapshot.protocol.reviewQuestion).toBe("X vs Y?");
    expect(snapshot.protocol.criteria).toHaveLength(1);
    expect(snapshot.protocol.criteria[0]).toMatchObject({ text: "Randomized controlled trials" });
    expect(snapshot.protocol.picoQuestions).toHaveLength(1);
    expect(snapshot.protocol.outcomes).toHaveLength(1);
    expect(snapshot.screeningStages).toHaveLength(1);
    expect(snapshot.screeningStages[0]).toMatchObject({
      id: stage.id,
      type: "TITLE_ABSTRACT",
      reviewersPerCitation: 2,
      blinded: true,
    });
    expect(snapshot.exclusionReasons).toHaveLength(1);
    expect(snapshot.exclusionReasons[0]).toMatchObject({
      label: "Wrong population",
      stage: "TITLE_ABSTRACT",
    });

    await prisma.auditEvent.findFirstOrThrow({
      where: { entityType: "ProtocolVersion", entityId: version.id, action: "protocol.published" },
    });

    // versions list exposes the snapshot; second publish becomes v2
    const v2 = await protocols.publishProtocol(ctx(owner.id), project.id);
    expect(v2.versionNumber).toBe(2);
    const versions = await protocols.listVersions(ctx(owner.id), project.id);
    expect(versions.map((v) => v.versionNumber)).toEqual([2, 1]);
    expect(versions[1]?.createdBy.id).toBe(owner.id);
  });

  it("exclusion reasons: create/update/list filters, duplicate label conflict", async () => {
    const { owner, reviewer1, project } = await createProjectWithTeam();

    const ta = await protocols.createExclusionReason(ctx(owner.id), project.id, {
      label: "Wrong study design",
      stage: "TITLE_ABSTRACT",
      order: 1,
    });
    await protocols.createExclusionReason(ctx(owner.id), project.id, {
      label: "No full text available",
      stage: "FULL_TEXT",
      order: 2,
    });
    const both = await protocols.createExclusionReason(ctx(owner.id), project.id, {
      label: "Not in English",
      order: 3,
    });
    expect(both.stage).toBe("BOTH");

    await expectAppError(
      protocols.createExclusionReason(ctx(owner.id), project.id, { label: "Wrong study design" }),
      "CONFLICT",
    );

    // stage filter returns stage-specific + BOTH; reviewer (project.view) can list
    const taList = await protocols.listExclusionReasons(ctx(reviewer1.id), project.id, {
      stage: "TITLE_ABSTRACT",
      includeInactive: false,
    });
    expect(taList.map((r) => r.label)).toEqual(["Wrong study design", "Not in English"]);

    const updated = await protocols.updateExclusionReason(ctx(owner.id), project.id, ta.id, {
      label: "Ineligible study design",
    });
    expect(updated.label).toBe("Ineligible study design");
    const updateEvent = await prisma.auditEvent.findFirstOrThrow({
      where: { entityType: "ExclusionReason", entityId: ta.id, action: "exclusion_reason.updated" },
    });
    expect(updateEvent.previousValue).toMatchObject({ label: "Wrong study design" });
    expect(updateEvent.newValue).toMatchObject({ label: "Ineligible study design" });

    // cross-project scoping
    const other = await createProjectWithTeam();
    await expectAppError(
      protocols.updateExclusionReason(ctx(other.owner.id), other.project.id, ta.id, { order: 9 }),
      "NOT_FOUND",
    );
  });

  it("deleting a referenced exclusion reason deactivates it; unreferenced is hard-deleted", async () => {
    const { owner, reviewer1, project } = await createProjectWithTeam();

    const referenced = await protocols.createExclusionReason(ctx(owner.id), project.id, {
      label: uniq("Referenced reason"),
      stage: "BOTH",
    });
    const unreferenced = await protocols.createExclusionReason(ctx(owner.id), project.id, {
      label: uniq("Unreferenced reason"),
      stage: "BOTH",
    });

    // a screening decision cites the first reason
    await beginScreening(project.id, reviewer1.id, {
      decision: "EXCLUDE",
      exclusionReasonId: referenced.id,
    });

    const softResult = await protocols.deleteExclusionReason(
      ctx(owner.id),
      project.id,
      referenced.id,
    );
    expect(softResult).toMatchObject({ deleted: false, deactivated: true });
    const stillThere = await prisma.exclusionReason.findUniqueOrThrow({
      where: { id: referenced.id },
    });
    expect(stillThere.isActive).toBe(false);
    const softEvent = await prisma.auditEvent.findFirstOrThrow({
      where: {
        entityType: "ExclusionReason",
        entityId: referenced.id,
        action: "exclusion_reason.deleted",
      },
    });
    expect(softEvent.previousValue).toMatchObject({ isActive: true });
    expect(softEvent.newValue).toMatchObject({ isActive: false });
    expect(softEvent.metadata).toMatchObject({ softDeleted: true });

    // default list hides it; includeInactive shows it
    const activeList = await protocols.listExclusionReasons(ctx(owner.id), project.id, {
      includeInactive: false,
    });
    expect(activeList.find((r) => r.id === referenced.id)).toBeUndefined();
    const fullList = await protocols.listExclusionReasons(ctx(owner.id), project.id, {
      includeInactive: true,
    });
    expect(fullList.find((r) => r.id === referenced.id)).toBeDefined();

    const hardResult = await protocols.deleteExclusionReason(
      ctx(owner.id),
      project.id,
      unreferenced.id,
    );
    expect(hardResult).toMatchObject({ deleted: true, deactivated: false });
    expect(await prisma.exclusionReason.findUnique({ where: { id: unreferenced.id } })).toBeNull();
    const hardEvent = await prisma.auditEvent.findFirstOrThrow({
      where: {
        entityType: "ExclusionReason",
        entityId: unreferenced.id,
        action: "exclusion_reason.deleted",
      },
    });
    expect(hardEvent.metadata).toMatchObject({ softDeleted: false });
  });

  it("permissions: REVIEWER cannot edit protocol or reasons; members can read; strangers get 403", async () => {
    const { owner, reviewer1, project } = await createProjectWithTeam();
    const stranger = await createProjectWithTeam(); // member of a different project only

    await expectAppError(
      protocols.updateProtocol(ctx(reviewer1.id), project.id, { background: "nope" }),
      "FORBIDDEN",
    );
    await expectAppError(
      protocols.createCriterion(ctx(reviewer1.id), project.id, { type: "INCLUSION", text: "x" }),
      "FORBIDDEN",
    );
    await expectAppError(
      protocols.createExclusionReason(ctx(reviewer1.id), project.id, { label: "x" }),
      "FORBIDDEN",
    );
    await expectAppError(protocols.publishProtocol(ctx(reviewer1.id), project.id), "FORBIDDEN");

    // reads: any project member
    await expect(protocols.getProtocol(ctx(reviewer1.id), project.id)).resolves.toBeTruthy();
    await expect(protocols.listVersions(ctx(reviewer1.id), project.id)).resolves.toEqual([]);
    await expect(protocols.listAmendments(ctx(reviewer1.id), project.id)).resolves.toEqual([]);

    // non-members of the project
    await expectAppError(protocols.getProtocol(ctx(stranger.owner.id), project.id), "FORBIDDEN");

    // amendments list carries the author
    await protocols.publishProtocol(ctx(owner.id), project.id);
    await beginScreening(project.id, reviewer1.id);
    await protocols.updateProtocol(ctx(owner.id), project.id, {
      gradePlan: "GRADE per outcome",
      amendmentReason: "Add GRADE plan",
    });
    const amendments = await protocols.listAmendments(ctx(owner.id), project.id);
    expect(amendments).toHaveLength(1);
    expect(amendments[0]?.createdBy.id).toBe(owner.id);
    expect(amendments[0]?.reason).toBe("Add GRADE plan");
  });
});
