// THE blinding leak tests — a blinded reviewer must never receive a co-reviewer's decision
// through any screening read surface (decision list, decision-write response, queue) until
// the stage is unblinded or the citation is settled. docs/02 "Blinding" + docs/09 R1.
import { beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/server/db";
import { AppError } from "@/server/errors";
import * as screening from "@/server/services/screening";
import { resetDb } from "../db-utils";
import { createProjectWithTeam, createTestCitation } from "../factories";

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

// Blinded 2-reviewer TITLE_ABSTRACT stage with A and B assigned to one citation.
async function blindedSetup() {
  const team = await createProjectWithTeam();
  const stage = await prisma.screeningStage.create({
    data: {
      projectId: team.project.id,
      type: "TITLE_ABSTRACT",
      reviewersPerCitation: 2,
      blinded: true,
      maybeGeneratesConflict: true,
    },
  });
  const citation = await createTestCitation(team.project.id);
  for (const u of [team.reviewer1, team.reviewer2]) {
    await prisma.screeningAssignment.create({
      data: { stageId: stage.id, citationId: citation.id, reviewerId: u.id },
    });
  }
  return { ...team, A: team.reviewer1, B: team.reviewer2, stage, citation };
}

describe("screening blinding", () => {
  beforeAll(async () => {
    await resetDb();
  });

  it("a blinded reviewer sees only their own decision; adjudicator and admin see all", async () => {
    const { A, B, adjudicator, owner, project, stage, citation } = await blindedSetup();

    // B decides first, then A — they disagree, so a conflict opens but NO result exists.
    await screening.createDecision(ctx(B.id), project.id, stage.id, {
      citationId: citation.id,
      decision: "EXCLUDE",
      notes: "B-secret-note",
    });
    const aResponse = await screening.createDecision(ctx(A.id), project.id, stage.id, {
      citationId: citation.id,
      decision: "INCLUDE",
      notes: "A-own-note",
    });
    const bDecision = await prisma.screeningDecision.findFirstOrThrow({
      where: { stageId: stage.id, citationId: citation.id, reviewerId: B.id },
    });

    // sanity: conflict open, no result — the blind must still hold
    expect(
      await prisma.citationStageResult.findUnique({
        where: { stageId_citationId: { stageId: stage.id, citationId: citation.id } },
      }),
    ).toBeNull();

    // the decision-write response itself must not leak B's decision
    const writeSerialized = JSON.stringify(aResponse);
    expect(writeSerialized).not.toContain(bDecision.id);
    expect(writeSerialized).not.toContain(B.id);
    expect(writeSerialized).not.toContain("B-secret-note");

    // A's decision list: own decision only — B's decision id AND B's userId absent
    const aView = await screening.listDecisions(ctx(A.id), project.id, stage.id, citation.id);
    const aSerialized = JSON.stringify(aView);
    expect(aView).toHaveLength(1);
    expect(aSerialized).toContain(aResponse.decision.id);
    expect(aSerialized).not.toContain(bDecision.id);
    expect(aSerialized).not.toContain(B.id);
    expect(aSerialized).not.toContain("B-secret-note");

    // symmetric for B
    const bView = await screening.listDecisions(ctx(B.id), project.id, stage.id, citation.id);
    const bSerialized = JSON.stringify(bView);
    expect(bSerialized).toContain(bDecision.id);
    expect(bSerialized).not.toContain(aResponse.decision.id);
    expect(bSerialized).not.toContain(A.id);

    // adjudicator (screening.adjudicate) sees both
    const adjView = await screening.listDecisions(
      ctx(adjudicator.id),
      project.id,
      stage.id,
      citation.id,
    );
    const adjSerialized = JSON.stringify(adjView);
    expect(adjView).toHaveLength(2);
    expect(adjSerialized).toContain(aResponse.decision.id);
    expect(adjSerialized).toContain(bDecision.id);

    // owner (project.edit) sees both
    const ownerView = await screening.listDecisions(ctx(owner.id), project.id, stage.id, citation.id);
    expect(ownerView).toHaveLength(2);
  });

  it("once a stage result exists, the blind lifts for that citation", async () => {
    const { A, B, project, stage, citation } = await blindedSetup();
    for (const u of [A, B]) {
      await screening.createDecision(ctx(u.id), project.id, stage.id, {
        citationId: citation.id,
        decision: "INCLUDE",
      });
    }
    // consensus result exists → A now sees B's decision even though stage.blinded=true
    const aView = await screening.listDecisions(ctx(A.id), project.id, stage.id, citation.id);
    expect(aView).toHaveLength(2);
    expect(new Set(aView.map((d) => d.reviewerId))).toEqual(new Set([A.id, B.id]));
  });

  it("unblinding the stage reveals decisions, stamps unblindedAt, and is audited", async () => {
    const { A, B, owner, project, stage, citation } = await blindedSetup();
    await screening.createDecision(ctx(A.id), project.id, stage.id, {
      citationId: citation.id,
      decision: "INCLUDE",
    });
    await screening.createDecision(ctx(B.id), project.id, stage.id, {
      citationId: citation.id,
      decision: "EXCLUDE",
    });

    // still blinded: A sees 1
    expect(
      await screening.listDecisions(ctx(A.id), project.id, stage.id, citation.id),
    ).toHaveLength(1);

    // a reviewer cannot reconfigure the stage
    await expectAppError(
      screening.updateStage(ctx(A.id), project.id, stage.id, { blinded: false }),
      "FORBIDDEN",
    );

    const updated = await screening.updateStage(ctx(owner.id), project.id, stage.id, {
      blinded: false,
    });
    expect(updated.blinded).toBe(false);
    expect(updated.unblindedAt).not.toBeNull();
    const event = await prisma.auditEvent.findFirstOrThrow({
      where: {
        entityType: "ScreeningStage",
        entityId: stage.id,
        action: "screening.stage.unblinded",
      },
    });
    expect(event.previousValue).toMatchObject({ blinded: true });

    // blind lifted: A sees both
    expect(
      await screening.listDecisions(ctx(A.id), project.id, stage.id, citation.id),
    ).toHaveLength(2);
  });

  it("the queue payload never contains other reviewers' decisions", async () => {
    const { A, B, project, stage, citation } = await blindedSetup();
    // B has decided; A is still pending on the same citation
    await screening.createDecision(ctx(B.id), project.id, stage.id, {
      citationId: citation.id,
      decision: "EXCLUDE",
      notes: "B-queue-secret",
    });
    const bDecision = await prisma.screeningDecision.findFirstOrThrow({
      where: { stageId: stage.id, citationId: citation.id, reviewerId: B.id },
    });

    const queue = await screening.getQueue(ctx(A.id), project.id, stage.id);
    expect(queue.total).toBe(1);
    expect(queue.items[0]!.citation.id).toBe(citation.id);
    expect(queue.items[0]!.myDecision).toBeNull();

    const serialized = JSON.stringify(queue);
    expect(serialized).toContain(citation.title);
    expect(serialized).not.toContain(bDecision.id);
    expect(serialized).not.toContain(B.id);
    expect(serialized).not.toContain("B-queue-secret");
  });

  it("an unblinded stage (blinded=false) shows co-reviewer decisions immediately", async () => {
    const team = await createProjectWithTeam();
    const stage = await prisma.screeningStage.create({
      data: {
        projectId: team.project.id,
        type: "TITLE_ABSTRACT",
        reviewersPerCitation: 2,
        blinded: false,
      },
    });
    const citation = await createTestCitation(team.project.id);
    for (const u of [team.reviewer1, team.reviewer2]) {
      await prisma.screeningAssignment.create({
        data: { stageId: stage.id, citationId: citation.id, reviewerId: u.id },
      });
    }
    await screening.createDecision(ctx(team.reviewer2.id), team.project.id, stage.id, {
      citationId: citation.id,
      decision: "MAYBE",
    });
    const view = await screening.listDecisions(
      ctx(team.reviewer1.id),
      team.project.id,
      stage.id,
      citation.id,
    );
    expect(view).toHaveLength(1);
    expect(view[0]!.reviewerId).toBe(team.reviewer2.id);
  });
});
