import { beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/server/db";
import { getScreeningScope } from "@/server/services/screening/scope";
import { createProject, createSubProject } from "@/server/services/projects";
import { saveGuidelineScreeningPool } from "@/server/services/screening/pooled";
import * as screening from "@/server/services/screening";
import * as quotas from "@/server/services/screening/quotas";
import * as dedup from "@/server/services/dedup";
import { resetDb } from "../db-utils";
import {
  createTestUser,
  createTestOrg,
  addOrgMember,
  addProjectMember,
  createProjectWithTeam,
  createTestCitation,
} from "../factories";

describe("read-only configured screening scope", () => {
  beforeAll(resetDb);
  async function fixture() {
    const owner = await createTestUser();
    const reader = await createTestUser();
    const outsider = await createTestUser();
    const org = await createTestOrg(owner.id);
    await addOrgMember(org.id, reader.id);
    const guideline = await createProject({ userId: owner.id }, org.id, {
      title: "Synthetic evidence guideline",
      reviewType: "GUIDELINE_EVIDENCE_REVIEW",
      isGuideline: true,
      reviewersPerCitation: 2,
    });
    await addProjectMember(guideline.id, reader.id, ["OBSERVER"]);
    const picos = [];
    for (let i = 0; i < 3; i++)
      picos.push(
        await createSubProject({ userId: owner.id }, guideline.id, {
          title: `Question ${i + 1}`,
          researchQuestion: `Configured question ${i + 1}`,
        }),
      );
    const pool = await saveGuidelineScreeningPool({ userId: owner.id }, guideline.id, {
      name: "Configured shared scope",
      projectIds: picos.slice(1).map((p) => p.id),
    });
    return { owner, reader, outsider, org, guideline, picos, pool };
  }
  it("reads all pooled definitions and preserves per-PICO exceptions without creating protocol rows", async () => {
    const f = await fixture();
    const protocol = await prisma.protocol.update({
      where: { projectId: f.picos[1]!.id },
      data: {
        projectId: f.picos[1]!.id,
        population: "Configured population A",
        studyDesigns: ["Configured design A"],
        criteria: {
          create: {
            type: "INCLUSION",
            text: "Configured exception for question A",
          },
        },
        picoQuestions: {
          create: {
            question: "Detailed configured question",
            population: "Question-specific population",
          },
        },
        versions: {
          create: { versionNumber: 1, createdById: f.owner.id, snapshot: {} },
        },
      },
    });
    await prisma.protocol.delete({ where: { projectId: f.picos[2]!.id } });
    const before = await prisma.protocol.count();
    const scope = await getScreeningScope({ userId: f.reader.id }, f.guideline.id, f.pool.id);
    expect(scope.combined).toBe(true);
    expect(scope.projects.map((p) => p.id)).toEqual(f.picos.slice(1).map((p) => p.id));
    expect(scope.projects[0]!.protocol).toMatchObject({
      population: "Configured population A",
      criteria: [{ type: "INCLUSION", text: "Configured exception for question A" }],
      versions: [{ versionNumber: 1 }],
    });
    expect(scope.projects[1]!.protocol).toBeNull();
    expect(await prisma.protocol.count()).toBe(before);
    expect(await prisma.protocol.findUnique({ where: { id: protocol.id } })).not.toBeNull();
    expect(JSON.stringify(scope)).not.toMatch(/reviewerId|myDecision|passwordHash|invitation/);
    const individual = await getScreeningScope({ userId: f.reader.id }, f.picos[0]!.id);
    expect(individual.projects.map((p) => p.id)).toEqual([f.picos[0]!.id]);
    expect(individual.combined).toBe(false);
  });
  it("enforces project and organization access for every included PICO and scopes pool IDs", async () => {
    const f = await fixture();
    await expect(
      getScreeningScope({ userId: f.outsider.id }, f.guideline.id, f.pool.id),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(
      getScreeningScope({ userId: f.reader.id }, f.guideline.id, "foreign-pool"),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(getScreeningScope({ userId: f.reader.id }, f.picos[1]!.id)).rejects.toMatchObject({
      code: "INVALID_STATE",
    });
    await prisma.projectMember.update({
      where: {
        projectId_userId: { projectId: f.picos[2]!.id, userId: f.reader.id },
      },
      data: { status: "REMOVED" },
    });
    await expect(
      getScreeningScope({ userId: f.reader.id }, f.guideline.id, f.pool.id),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    await prisma.organizationMember.update({
      where: { orgId_userId: { orgId: f.org.id, userId: f.reader.id } },
      data: { status: "REMOVED" },
    });
    await expect(getScreeningScope({ userId: f.reader.id }, f.picos[0]!.id)).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
  });
  it("recomputes personal credit after merge/undo and counts decision revisions once", async () => {
    const team = await createProjectWithTeam();
    const owner = { userId: team.owner.id };
    const reviewer = { userId: team.reviewer1.id };
    const stage = (await screening.ensureStages(team.project.id)).find(
      (s) => s.type === "TITLE_ABSTRACT",
    )!;
    const a = await createTestCitation(team.project.id, {
      title: "Synthetic matching abstract",
      doi: "10.1234/scope-undo",
    });
    const b = await createTestCitation(team.project.id, {
      title: "Synthetic matching abstract",
      doi: "10.1234/scope-undo",
    });
    await quotas.saveQuotas(
      owner,
      team.project.id,
      { stageId: stage.id },
      { reviewers: [{ reviewerId: reviewer.userId, target: 4 }] },
    );
    for (const citation of [a, b])
      await screening.createDecision(reviewer, team.project.id, stage.id, {
        citationId: citation.id,
        decision: "INCLUDE",
      });
    const progress = () => quotas.quotaProgress(prisma, { stageId: stage.id }, reviewer.userId);
    expect(await progress()).toMatchObject({ completed: 2, remaining: 2 });
    await dedup.runDetection(owner, team.project.id);
    const group = await prisma.deduplicationGroup.findFirstOrThrow({
      where: { projectId: team.project.id, status: "OPEN" },
    });
    await dedup.mergeGroup(owner, team.project.id, group.id, { canonicalCitationId: a.id });
    expect(await progress()).toMatchObject({ completed: 1, remaining: 3 });
    await dedup.undoMerge(owner, team.project.id, b.id);
    expect(await progress()).toMatchObject({ completed: 2, remaining: 2 });
    await screening.createDecision(reviewer, team.project.id, stage.id, {
      citationId: b.id,
      decision: "MAYBE",
      notes: "Synthetic re-review",
    });
    expect(await progress()).toMatchObject({ completed: 2, remaining: 2 });
    expect(
      await prisma.screeningDecision.count({
        where: { stageId: stage.id, reviewerId: reviewer.userId },
      }),
    ).toBe(2);
  });
});
