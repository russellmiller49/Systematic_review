import { z } from "zod";
import { prisma, type Tx } from "@/server/db";
import type { Ctx } from "@/server/auth/session";
import { can, requirePermission } from "@/server/permissions";
import { invalidState, notFound, validationError } from "@/server/errors";
import * as audit from "@/server/services/audit";
import { groupPooledCitationRows } from "./grouping";

export const saveQuotasSchema = z.object({
  reviewers: z
    .array(
      z.object({
        reviewerId: z.string().min(1),
        target: z.number().int().min(0).max(1_000_000),
      }),
    )
    .min(1)
    .max(50)
    .refine(
      (rows) => new Set(rows.map((r) => r.reviewerId)).size === rows.length,
      "Reviewers must be unique",
    ),
});

export type QuotaScope =
  | { stageId: string; poolId?: never }
  | { poolId: string; stageId?: never };

// Serialize screening writes in a consistent order. This protects both article capacity
// and each reviewer's remaining quota, including requests from multiple browser tabs.
export async function lockScreeningStages(tx: Tx, stageIds: string[]) {
  for (const id of [...new Set(stageIds)].sort()) {
    await tx.$queryRaw`SELECT "id" FROM "ScreeningStage" WHERE "id" = ${id} FOR UPDATE`;
  }
}

async function completedByReviewer(
  db: Tx,
  scope: QuotaScope,
  reviewerId?: string,
) {
  if (scope.stageId) {
    const rows = await db.screeningAssignment.groupBy({
      by: ["reviewerId"],
      where: {
        stageId: scope.stageId,
        reviewerId,
        status: "COMPLETED",
        citation: { status: "ACTIVE" },
      },
      _count: { _all: true },
    });
    return new Map(rows.map((row) => [row.reviewerId, row._count._all]));
  }
  const members = await db.guidelineScreeningPoolMember.findMany({
    where: { poolId: scope.poolId },
  });
  const rows = await db.citation.findMany({
    where: {
      projectId: { in: members.map((m) => m.projectId) },
      status: "ACTIVE",
    },
    select: {
      id: true,
      projectId: true,
      doi: true,
      pmid: true,
      normalizedTitle: true,
      createdAt: true,
      assignments: {
        where: {
          reviewerId,
          status: "COMPLETED",
          stage: { type: "TITLE_ABSTRACT" },
        },
        select: { reviewerId: true },
      },
    },
  });
  const counts = new Map<string, number>();
  // One abstract counts once, even when the pooled decision wrote to several PICOs.
  for (const group of groupPooledCitationRows(rows)) {
    // Credit historical work even when a newly imported copy needs synchronization.
    for (const id of new Set(
      group.flatMap((c) => c.assignments.map((a) => a.reviewerId)),
    )) {
      counts.set(id, (counts.get(id) ?? 0) + 1);
    }
  }

  return counts;
}

export async function quotaProgress(
  db: Tx,
  scope: QuotaScope,
  reviewerId: string,
) {
  const quota = await db.screeningQuota.findFirst({
    where: { ...scope, reviewerId },
  });
  if (!quota) return null;
  const completed =
    (await completedByReviewer(db, scope, reviewerId)).get(reviewerId) ?? 0;
  return {
    target: quota.target,
    completed,
    remaining: Math.max(0, quota.target - completed),
  };
}

async function resolveScope(ctx: Ctx, projectId: string, scope: QuotaScope) {
  await requirePermission(ctx, projectId, "screening.configure");
  const project = await prisma.project.findUniqueOrThrow({
    where: { id: projectId },
  });
  let projectIds: string[];
  if (scope.stageId) {
    const stage = await prisma.screeningStage.findFirst({
      where: { id: scope.stageId, projectId, type: "TITLE_ABSTRACT" },
    });
    if (!stage) throw notFound("Title/abstract screening stage");
    if (
      await prisma.guidelineScreeningPoolMember.findUnique({
        where: { projectId },
      })
    ) {
      throw invalidState(
        "Manage shared quotas from the guideline's combined pool",
      );
    }
    projectIds = [projectId];
  } else {
    const pool = await prisma.guidelineScreeningPool.findFirst({
      where: { id: scope.poolId, guidelineId: projectId },
      include: { members: true },
    });
    if (!pool) throw notFound("Screening pool");
    projectIds = pool.members.map((m) => m.projectId);
    for (const id of projectIds)
      await requirePermission(ctx, id, "screening.configure");
  }
  const stages = await prisma.screeningStage.findMany({
    where: { projectId: { in: projectIds }, type: "TITLE_ABSTRACT" },
  });
  if (
    stages.length !== projectIds.length ||
    stages.some((s) => s.reviewersPerCitation !== 2)
  ) {
    throw invalidState(
      "Shared reviewer quotas require dual title/abstract screening (two reviewers per abstract)",
    );
  }
  return { project, projectIds, stages };
}

export async function listQuotas(
  ctx: Ctx,
  projectId: string,
  scope: QuotaScope,
) {
  const { project, projectIds } = await resolveScope(ctx, projectId, scope);
  const members = await prisma.projectMember.findMany({
    where: {
      projectId: { in: projectIds },
      status: "ACTIVE",
      user: {
        orgMemberships: { some: { orgId: project.orgId, status: "ACTIVE" } },
      },
    },
    include: { user: { select: { id: true, name: true, email: true } } },
  });
  const users = new Map(members.map((m) => [m.userId, m.user]));
  const [savedQuotas, completedCounts] = await Promise.all([
    prisma.screeningQuota.findMany({ where: scope }),
    completedByReviewer(prisma, scope),
  ]);
  const reviewers = [];
  for (const user of users.values()) {
    if (
      !projectIds.every((id) =>
        members.some(
          (m) =>
            m.projectId === id &&
            m.userId === user.id &&
            can(m.roles, "screening.decide"),
        ),
      )
    )
      continue;
    const saved = savedQuotas.find((q) => q.reviewerId === user.id);
    const completed = completedCounts.get(user.id) ?? 0;
    reviewers.push({
      ...user,
      quota: saved
        ? {
            target: saved.target,
            completed,
            remaining: Math.max(0, saved.target - completed),
          }
        : null,
    });
  }
  return { reviewers };
}

// Upsert only the supplied reviewers. A zero target pauses new reviews while preserving
// the assignment and its completed work. Prior reviews in this corpus count toward targets.
export async function saveQuotas(
  ctx: Ctx,
  projectId: string,
  scope: QuotaScope,
  input: z.infer<typeof saveQuotasSchema>,
) {
  input = saveQuotasSchema.parse(input);
  const { stages } = await resolveScope(ctx, projectId, scope);
  const eligible = await listQuotas(ctx, projectId, scope);
  if (
    input.reviewers.some(
      (row) => !eligible.reviewers.some((m) => m.id === row.reviewerId),
    )
  ) {
    throw validationError(
      "Every reviewer must be an active workspace and screening member of every selected project",
    );
  }
  return prisma.$transaction(async (tx) => {
    await lockScreeningStages(
      tx,
      stages.map((s) => s.id),
    );
    if (scope.poolId) {
      const members = await tx.guidelineScreeningPoolMember.findMany({
        where: { poolId: scope.poolId },
      });
      if (
        members.length !== stages.length ||
        members.some((m) => !stages.some((s) => s.projectId === m.projectId))
      ) {
        throw invalidState(
          "The screening pool changed. Reload reviewer quotas before saving.",
        );
      }
    }
    const currentStages = await tx.screeningStage.findMany({
      where: { id: { in: stages.map((s) => s.id) } },
    });
    if (
      currentStages.length !== stages.length ||
      currentStages.some((stage) => stage.reviewersPerCitation !== 2)
    ) {
      throw invalidState(
        "Shared reviewer quotas require two reviewers per abstract",
      );
    }
    for (const row of input.reviewers) {
      const before = await tx.screeningQuota.findFirst({
        where: { ...scope, reviewerId: row.reviewerId },
      });
      const quota = before
        ? await tx.screeningQuota.update({
            where: { id: before.id },
            data: { target: row.target },
          })
        : await tx.screeningQuota.create({ data: { ...scope, ...row } });
      await audit.record(tx, {
        projectId,
        userId: ctx.userId,
        entityType: "ScreeningQuota",
        entityId: quota.id,
        action: audit.AuditActions.SCREENING_QUOTA_UPDATED,
        previousValue: before ? { target: before.target } : undefined,
        newValue: { ...scope, ...row },
      });
    }
    return { updated: input.reviewers.length };
  });
}

// Used by queues as well as writes: a disagreement consumes both review slots too.
export async function completedReviewCounts(db: Tx, stageIds: string[]) {
  const rows = await db.screeningAssignment.groupBy({
    by: ["citationId"],
    where: { stageId: { in: stageIds }, status: "COMPLETED" },
    _count: { _all: true },
  });
  return new Map(rows.map((row) => [row.citationId, row._count._all]));
}
