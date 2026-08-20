import { beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/server/db";
import { AppError } from "@/server/errors";
import * as citations from "@/server/services/citations";
import { resetDb } from "../db-utils";
import {
  createProjectWithTeam,
  createTestCitation,
  createTestProject,
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

describe("citations service", () => {
  beforeAll(async () => {
    await resetDb();
  });

  it("lets an assigned screener fill a missing abstract, audits it, and invalidates stale AI scores", async () => {
    const { owner, reviewer1, project } = await createProjectWithTeam();
    const citation = await createTestCitation(project.id);
    await prisma.citation.update({
      where: { id: citation.id },
      data: { abstract: null },
    });
    const stage = await prisma.screeningStage.create({
      data: {
        projectId: project.id,
        type: "TITLE_ABSTRACT",
        reviewersPerCitation: 2,
      },
    });
    // Completed assignments remain part of the reviewer's assigned corpus, so metadata can
    // still be repaired after their decision is submitted.
    await prisma.screeningAssignment.create({
      data: {
        stageId: stage.id,
        citationId: citation.id,
        reviewerId: reviewer1.id,
        status: "COMPLETED",
      },
    });
    const run = await prisma.aiScreeningRun.create({
      data: {
        projectId: project.id,
        stageId: stage.id,
        status: "COMPLETED",
        provider: "test",
        model: "test-model",
        promptVersion: "screening-test",
        totalCount: 1,
        succeededCount: 1,
        requestedById: owner.id,
        completedAt: new Date(),
      },
    });
    await prisma.screeningSuggestion.create({
      data: {
        stageId: stage.id,
        citationId: citation.id,
        runId: run.id,
        score: 72,
        suggestedDecision: "INCLUDE",
        rationale: "Based on the title-only input.",
        provider: run.provider,
        model: run.model,
        promptVersion: run.promptVersion,
      },
    });

    const result = await citations.addCitationAbstract(
      ctx(reviewer1.id),
      project.id,
      citation.id,
      { abstract: "Background: manually recovered abstract. Methods: reviewer transcription." },
    );

    expect(result.citation.abstract).toBe(
      "Background: manually recovered abstract. Methods: reviewer transcription.",
    );
    expect(result.aiSuggestionsInvalidated).toBe(1);
    expect(
      await prisma.screeningSuggestion.count({ where: { citationId: citation.id } }),
    ).toBe(0);

    const event = await prisma.auditEvent.findFirstOrThrow({
      where: {
        projectId: project.id,
        entityType: "Citation",
        entityId: citation.id,
        action: "citation.abstract.added",
      },
    });
    expect(event.userId).toBe(reviewer1.id);
    expect(event.previousValue).toEqual({ abstract: null });
    expect(event.newValue).toEqual({ abstract: result.citation.abstract });
    expect(event.metadata).toEqual({ aiSuggestionsInvalidated: 1 });

    await expectAppError(
      citations.addCitationAbstract(ctx(reviewer1.id), project.id, citation.id, {
        abstract: "A replacement should not be allowed.",
      }),
      "INVALID_STATE",
    );
  });

  it("requires either citation-management authority or a live personal assignment", async () => {
    const { owner, reviewer1, reviewer2, org, project } = await createProjectWithTeam();
    const citation = await createTestCitation(project.id);
    await prisma.citation.update({
      where: { id: citation.id },
      data: { abstract: null },
    });

    await expectAppError(
      citations.addCitationAbstract(ctx(reviewer2.id), project.id, citation.id, {
        abstract: "An unassigned reviewer must not change shared metadata.",
      }),
      "FORBIDDEN",
    );

    const stage = await prisma.screeningStage.create({
      data: { projectId: project.id, type: "TITLE_ABSTRACT" },
    });
    await prisma.screeningAssignment.create({
      data: {
        stageId: stage.id,
        citationId: citation.id,
        reviewerId: reviewer1.id,
        status: "VOIDED",
      },
    });
    await expectAppError(
      citations.addCitationAbstract(ctx(reviewer1.id), project.id, citation.id, {
        abstract: "A voided assignment is not enough.",
      }),
      "FORBIDDEN",
    );

    // Owners can repair imported metadata without assigning themselves as screeners.
    await expect(
      citations.addCitationAbstract(ctx(owner.id), project.id, citation.id, {
        abstract: "Owner-supplied abstract.",
      }),
    ).resolves.toMatchObject({ citation: { abstract: "Owner-supplied abstract." } });

    const otherProject = await createTestProject(org.id, owner.id);
    const foreignCitation = await createTestCitation(otherProject.id);
    await prisma.citation.update({
      where: { id: foreignCitation.id },
      data: { abstract: null },
    });
    await expectAppError(
      citations.addCitationAbstract(ctx(owner.id), project.id, foreignCitation.id, {
        abstract: "Cross-project citation IDs must remain tenant-scoped.",
      }),
      "NOT_FOUND",
    );
  });
});
