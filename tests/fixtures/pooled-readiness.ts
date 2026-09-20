import { randomUUID } from "node:crypto";
import { prisma } from "@/server/db";
import * as projects from "@/server/services/projects";
import * as pooled from "@/server/services/screening/pooled";
import * as quotas from "@/server/services/screening/quotas";
import { createTestOrg, createTestUser } from "../factories";

export async function pooledReadinessFixture(
  options: {
    count?: number;
    reviewers?: number;
    seededProgress?: boolean;
  } = {},
) {
  const { count = 4, reviewers = 3, seededProgress = false } = options;
  const owner = await createTestUser({ name: "Readiness Owner" });
  const org = await createTestOrg(owner.id);
  const users: Awaited<ReturnType<typeof createTestUser>>[] = [];
  for (let i = 0; i < reviewers; i++)
    users.push(await createTestUser({ name: `Readiness Reviewer ${i}` }));
  await prisma.organizationMember.createMany({
    data: users.map((user) => ({
      orgId: org.id,
      userId: user.id,
      role: "MEMBER" as const,
    })),
  });
  const guideline = await projects.createProject({ userId: owner.id }, org.id, {
    title: "Readiness guideline",
    reviewType: "GUIDELINE_EVIDENCE_REVIEW",
    isGuideline: true,
    reviewersPerCitation: 2,
  });
  await prisma.projectMember.createMany({
    data: users.map((user) => ({
      projectId: guideline.id,
      userId: user.id,
      roles: ["REVIEWER" as const],
    })),
  });
  const picos: Awaited<ReturnType<typeof projects.createSubProject>>[] = [];
  for (let i = 1; i <= 6; i++)
    picos.push(
      await projects.createSubProject({ userId: owner.id }, guideline.id, {
        title: `PICO ${i}`,
        researchQuestion: `Question ${i}`,
      }),
    );
  const pool = await pooled.saveGuidelineScreeningPool(
    { userId: owner.id },
    guideline.id,
    { name: "Readiness PICO 2–6", projectIds: picos.slice(1).map((p) => p.id) },
  );
  const stages = await prisma.screeningStage.findMany({
    where: {
      projectId: { in: picos.map((p) => p.id) },
      type: "TITLE_ABSTRACT",
    },
  });
  const stageByProject = new Map(
    stages.map((stage) => [stage.projectId, stage]),
  );
  const groups: { id: string; projectId: string; stageId: string }[][] = [];
  const citationRows = [];
  const assignments = [];
  const decisions = [];
  const results = [];
  for (let i = 0; i < count; i++) {
    const projectIndexes =
      i === 0
        ? [1, 2, 4]
        : Array.from(
            { length: i < 983 ? 3 : 2 },
            (_, copy) => 1 + ((i + copy) % 5),
          );
    const group = projectIndexes.map((index) => ({
      id: randomUUID(),
      projectId: picos[index]!.id,
      stageId: stageByProject.get(picos[index]!.id)!.id,
    }));
    groups.push(group);
    for (const copy of group) {
      citationRows.push({
        id: copy.id,
        projectId: copy.projectId,
        title: `Readiness abstract ${String(i).padStart(4, "0")}`,
        normalizedTitle: `readiness abstract ${i}`,
        doi: `10.6000/readiness-${i}`,
        pmid: String(800000 + i),
        authors: [{ family: "ReadinessAuthor" }],
        abstract:
          `Searchable abstract number ${i}. ` +
          "Study abstract content. ".repeat(60),
        createdAt: new Date(Date.UTC(2020, 0, 1) + i * 1000),
      });
      if (seededProgress && i < 3600) {
        for (const reviewerIndex of i < 2000
          ? [i % reviewers, (i + 17) % reviewers]
          : [i % reviewers]) {
          const reviewerId = users[reviewerIndex]!.id;
          assignments.push({
            stageId: copy.stageId,
            citationId: copy.id,
            reviewerId,
            status: "COMPLETED" as const,
          });
          decisions.push({
            stageId: copy.stageId,
            citationId: copy.id,
            reviewerId,
            decision: "INCLUDE" as const,
            notes: "Seeded historical review",
            labels: [],
          });
        }
        if (i < 2000)
          results.push({
            stageId: copy.stageId,
            citationId: copy.id,
            outcome: "INCLUDE" as const,
            resolvedVia: "CONSENSUS" as const,
          });
      }
    }
  }
  for (let i = 0; i < citationRows.length; i += 500)
    await prisma.citation.createMany({ data: citationRows.slice(i, i + 500) });
  for (let i = 0; i < assignments.length; i += 500)
    await prisma.screeningAssignment.createMany({
      data: assignments.slice(i, i + 500),
    });
  for (let i = 0; i < decisions.length; i += 500)
    await prisma.screeningDecision.createMany({
      data: decisions.slice(i, i + 500),
    });
  for (let i = 0; i < results.length; i += 500)
    await prisma.citationStageResult.createMany({
      data: results.slice(i, i + 500),
    });
  await quotas.saveQuotas(
    { userId: owner.id },
    guideline.id,
    { poolId: pool.id },
    {
      reviewers: users.map((user) => ({
        reviewerId: user.id,
        target: seededProgress ? 200 : 10,
      })),
    },
  );
  const decide = (
    userIndex: number,
    groupIndex: number,
    decision: "INCLUDE" | "EXCLUDE" | "MAYBE" = "INCLUDE",
    notes?: string,
  ) =>
    pooled.createPooledDecision(
      { userId: users[userIndex]!.id },
      guideline.id,
      {
        poolId: pool.id,
        citationIds: groups[groupIndex]!.map((c) => c.id),
        decision,
        notes,
        ...(decision === "EXCLUDE"
          ? { exclusionReasonLabel: "Wrong population" }
          : {}),
      },
    );
  const queue = (
    userIndex = 0,
    query: Partial<{
      page: number;
      limit: number;
      q: string;
      status: "AVAILABLE" | "MY_REVIEWED" | "ALL";
    }> = {},
  ) =>
    pooled.getPooledQueue(
      { userId: userIndex === -1 ? owner.id : users[userIndex]!.id },
      guideline.id,
      { poolId: pool.id, ...query },
    );
  return {
    owner,
    org,
    users,
    guideline,
    picos,
    pool,
    stages,
    groups,
    decide,
    queue,
  };
}
