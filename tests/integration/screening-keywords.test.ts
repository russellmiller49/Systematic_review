import { beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/server/db";
import { AppError } from "@/server/errors";
import * as screening from "@/server/services/screening";
import * as screeningKeywords from "@/server/services/screening-keywords";
import { resetDb } from "../db-utils";
import {
  addOrgMember,
  addProjectMember,
  createProjectWithTeam,
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

describe("screening keywords", () => {
  beforeAll(async () => {
    await resetDb();
  });

  it("creates normalized shared keywords, skips duplicates, and audits changes", async () => {
    const { owner, reviewer1, project } = await createProjectWithTeam();

    const result = await screeningKeywords.createScreeningKeywords(ctx(reviewer1.id), project.id, {
      terms: [" Randomized   Trial ", "ANIMAL", "randomized trial"],
      category: "INCLUDE",
    });
    expect(result.created).toHaveLength(2);
    expect(result.created.map((keyword) => keyword.normalizedTerm)).toEqual([
      "randomized trial",
      "animal",
    ]);

    const duplicate = await screeningKeywords.createScreeningKeywords(
      ctx(reviewer1.id),
      project.id,
      { terms: ["RANDOMIZED TRIAL"], category: "EXCLUDE" },
    );
    expect(duplicate).toMatchObject({ created: [], skippedTerms: ["RANDOMIZED TRIAL"] });

    const listed = await screeningKeywords.listScreeningKeywords(ctx(owner.id), project.id);
    expect(listed).toHaveLength(2);
    const randomized = listed.find((keyword) => keyword.normalizedTerm === "randomized trial")!;
    const updated = await screeningKeywords.updateScreeningKeyword(
      ctx(reviewer1.id),
      project.id,
      randomized.id,
      { category: "EXCLUDE" },
    );
    expect(updated.category).toBe("EXCLUDE");

    await screeningKeywords.deleteScreeningKeyword(
      ctx(reviewer1.id),
      project.id,
      randomized.id,
    );
    expect(await prisma.screeningKeyword.findUnique({ where: { id: randomized.id } })).toBeNull();
    const actions = await prisma.auditEvent.findMany({
      where: { projectId: project.id, entityType: "ScreeningKeyword" },
      orderBy: { createdAt: "asc" },
      select: { action: true, userId: true },
    });
    expect(actions.map((event) => event.action)).toEqual([
      "screening.keyword.created",
      "screening.keyword.created",
      "screening.keyword.updated",
      "screening.keyword.deleted",
    ]);
    expect(actions.every((event) => event.userId === reviewer1.id)).toBe(true);
  });

  it("lets project viewers read keywords but limits shared edits to screeners", async () => {
    const { owner, project, org } = await createProjectWithTeam();
    const observer = await createTestUser({ name: "Observer" });
    await addOrgMember(org.id, observer.id);
    await addProjectMember(project.id, observer.id, ["OBSERVER"]);

    await expect(
      screeningKeywords.listScreeningKeywords(ctx(observer.id), project.id),
    ).resolves.toEqual([]);
    await expectAppError(
      screeningKeywords.createScreeningKeywords(ctx(observer.id), project.id, {
        terms: ["blocked"],
        category: "EXCLUDE",
      }),
      "FORBIDDEN",
    );

    const created = await screeningKeywords.createScreeningKeywords(ctx(owner.id), project.id, {
      terms: ["shared"],
      category: "INCLUDE",
    });
    const otherOwner = await createTestUser();
    const otherOrg = await createTestOrg(otherOwner.id);
    const otherProject = await createTestProject(otherOrg.id, otherOwner.id);
    await expectAppError(
      screeningKeywords.deleteScreeningKeyword(
        ctx(otherOwner.id),
        otherProject.id,
        created.created[0]!.id,
      ),
      "NOT_FOUND",
    );
  });

  it("groups both the personal queue and blind-safe admin overview by keyword matches", async () => {
    const { owner, reviewer1, project } = await createProjectWithTeam();
    const stages = await screening.ensureStages(project.id);
    const stage = stages.find((item) => item.type === "TITLE_ABSTRACT")!;
    await prisma.screeningStage.update({
      where: { id: stage.id },
      data: { reviewersPerCitation: 1 },
    });

    const randomized = await createTestCitation(project.id, {
      title: "Randomized trial of airway valves",
      abstract: "Adults received bronchoscopic treatment.",
    });
    const animal = await createTestCitation(project.id, {
      title: "Preclinical airway study",
      abstract: "An animal model was used.",
    });
    const unmatched = await createTestCitation(project.id, {
      title: "Clinical practice overview",
      abstract: "A broad narrative summary.",
    });
    await prisma.screeningAssignment.createMany({
      data: [randomized, animal, unmatched].map((citation) => ({
        stageId: stage.id,
        citationId: citation.id,
        reviewerId: reviewer1.id,
      })),
    });

    const created = await screeningKeywords.createScreeningKeywords(ctx(owner.id), project.id, {
      terms: ["randomized", "animal"],
      category: "INCLUDE",
    });
    const randomizedKeyword = created.created.find(
      (keyword) => keyword.normalizedTerm === "randomized",
    )!;

    const groupedQueue = await screening.getQueue(ctx(reviewer1.id), project.id, stage.id, {
      keywordGroup: randomizedKeyword.id,
    });
    expect(groupedQueue.total).toBe(1);
    expect(groupedQueue.items[0]!.citation.id).toBe(randomized.id);

    const unmatchedQueue = await screening.getQueue(ctx(reviewer1.id), project.id, stage.id, {
      keywordGroup: screeningKeywords.UNMATCHED_KEYWORD_GROUP,
    });
    expect(unmatchedQueue.total).toBe(1);
    expect(unmatchedQueue.items[0]!.citation.id).toBe(unmatched.id);

    const overview = await screening.getAdminOverview(
      ctx(owner.id),
      project.id,
      stage.id,
      screening.adminOverviewQuerySchema.parse({
        keywordGroup: randomizedKeyword.id,
        limit: 25,
      }),
    );
    expect(overview.summary.totalEligible).toBe(1);
    expect(overview.items.map((item) => item.citation.id)).toEqual([randomized.id]);

    await expectAppError(
      screening.getQueue(ctx(reviewer1.id), project.id, stage.id, {
        keywordGroup: "unknown-keyword",
      }),
      "NOT_FOUND",
    );
  });
});
