// Guideline-level pooled title/abstract screening.
//
// A guideline stores each PICO as an independent review project. This service presents the
// administrator-configured PICO projects as one blind-safe reviewer queue, groups exact cross-PICO citation
// matches, authorizes open selection by reviewer quota, and writes one human choice to
// every linked PICO record atomically. The underlying per-project ScreeningDecision,
// ScreeningAssignment, conflict, and CitationStageResult rows remain the source of truth.

import { z } from "zod";
import { Prisma, type ScreeningStage } from "@prisma/client";
import { quotaProgress, lockScreeningStages } from "./quotas";
import { groupPooledCitationRows } from "./grouping";
import { loadPooledState, pooledReviewerState } from "./pooled-state";
import { prisma } from "@/server/db";
import {
  forbidden,
  invalidState,
  notFound,
  validationError,
} from "@/server/errors";
import type { Ctx } from "@/server/auth/session";
import { can, requirePermission, type Capability } from "@/server/permissions";
import * as audit from "@/server/services/audit";
import { AuditActions } from "@/server/services/audit";
import {
  createDecisionInTransaction,
  ensureStages,
} from "@/server/services/screening";

const projectIdsSchema = z
  .array(z.string().trim().min(1))
  .min(2, "Choose at least two PICO projects")
  .max(50)
  .refine(
    (ids) => new Set(ids).size === ids.length,
    "PICO projects must be unique",
  );

export const pooledSelectionSchema = z.object({
  poolId: z.string().trim().min(1),
});

export const pooledNavigatorQuerySchema = pooledSelectionSchema.extend({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  q: z.string().trim().max(500).optional(),
  status: z.enum(["AVAILABLE", "MY_REVIEWED", "ALL"]).default("AVAILABLE"),
});

export const createPooledAssignmentsSchema = z.object({
  poolId: z.string().trim().min(1),
  reviewerIds: z.array(z.string().trim().min(1)).min(1).max(50),
  strategy: z.enum(["all", "split"]),
});

export const createPooledDecisionSchema = z.object({
  poolId: z.string().trim().min(1),
  citationIds: z
    .array(z.string().trim().min(1))
    .min(1)
    .max(200)
    .refine(
      (ids) => new Set(ids).size === ids.length,
      "Citations must be unique",
    ),
  decision: z.enum(["INCLUDE", "EXCLUDE", "MAYBE"]),
  exclusionReasonLabel: z.string().trim().min(1).max(300).nullable().optional(),
  notes: z.string().max(20_000).nullable().optional(),
});

export const saveGuidelineScreeningPoolSchema = z.object({
  name: z.string().trim().min(2).max(120),
  projectIds: projectIdsSchema,
});

export { groupPooledCitationRows } from "./grouping";

async function loadGuideline(
  ctx: Ctx,
  guidelineId: string,
  capability: Capability,
) {
  await requirePermission(ctx, guidelineId, capability);
  const guideline = await prisma.project.findFirst({
    where: { id: guidelineId, isGuideline: true, parentProjectId: null },
    select: {
      id: true,
      title: true,
      subProjects: {
        orderBy: { createdAt: "asc" },
        select: { id: true, title: true, researchQuestion: true },
      },
    },
  });
  if (!guideline) throw notFound("Guideline");

  return {
    id: guideline.id,
    title: guideline.title,
    subProjects: guideline.subProjects.map((project, index) => ({
      ...project,
      picoNumber: index + 1,
    })),
  };
}

export async function getGuidelineScreeningConfiguration(
  ctx: Ctx,
  guidelineId: string,
) {
  const guideline = await loadGuideline(ctx, guidelineId, "project.view");
  const pool = await prisma.guidelineScreeningPool.findUnique({
    where: { guidelineId },
    include: {
      members: {
        select: { projectId: true },
        orderBy: { order: "asc" },
      },
    },
  });
  const pooledIds = new Set(
    pool?.members.map((member) => member.projectId) ?? [],
  );
  const pooledPicos = guideline.subProjects.filter((project) =>
    pooledIds.has(project.id),
  );
  const unpooledPicos = guideline.subProjects.filter(
    (project) => !pooledIds.has(project.id),
  );

  return {
    guideline: { id: guideline.id, title: guideline.title },
    pool: pool
      ? {
          id: pool.id,
          name: pool.name,
          picos: pooledPicos,
          createdAt: pool.createdAt,
          updatedAt: pool.updatedAt,
        }
      : null,
    unpooledPicos,
    allPicos: guideline.subProjects,
  };
}

export async function saveGuidelineScreeningPool(
  ctx: Ctx,
  guidelineId: string,
  input: z.infer<typeof saveGuidelineScreeningPoolSchema>,
) {
  const guideline = await loadGuideline(ctx, guidelineId, "project.edit");
  const requested = new Set(input.projectIds);
  const selected = guideline.subProjects.filter((project) =>
    requested.has(project.id),
  );
  if (selected.length !== requested.size) {
    throw validationError(
      "Every pooled project must be a PICO in this guideline",
    );
  }
  const orderedProjectIds = selected.map((project) => project.id);
  const selectedStages = await titleAbstractStages(orderedProjectIds);

  return prisma.$transaction(async (tx) => {
    const familyStages = await tx.screeningStage.findMany({
      where: {
        project: { parentProjectId: guidelineId },
        type: "TITLE_ABSTRACT",
      },
      select: { id: true },
    });
    await lockScreeningStages(
      tx,
      familyStages.map((s) => s.id),
    );
    const before = await tx.guidelineScreeningPool.findUnique({
      where: { guidelineId },
      include: { members: { orderBy: { order: "asc" } } },
    });
    const lockedStages = await tx.screeningStage.findMany({
      where: { id: { in: selectedStages.map((s) => s.id) } },
    });
    assertCompatibleStages(lockedStages);
    if (
      before &&
      (await tx.screeningQuota.count({ where: { poolId: before.id } }))
    ) {
      if (lockedStages.some((stage) => stage.reviewersPerCitation !== 2)) {
        throw invalidState(
          "A pool with shared reviewer quotas requires two reviewers per abstract",
        );
      }
    }
    const pool = before
      ? await tx.guidelineScreeningPool.update({
          where: { id: before.id },
          data: { name: input.name },
        })
      : await tx.guidelineScreeningPool.create({
          data: {
            guidelineId,
            name: input.name,
            createdById: ctx.userId,
          },
        });
    await tx.guidelineScreeningPoolMember.deleteMany({
      where: { poolId: pool.id },
    });
    await tx.guidelineScreeningPoolMember.createMany({
      data: orderedProjectIds.map((projectId, order) => ({
        poolId: pool.id,
        projectId,
        order,
      })),
    });
    await audit.record(tx, {
      projectId: guidelineId,
      userId: ctx.userId,
      entityType: "GuidelineScreeningPool",
      entityId: pool.id,
      action: before
        ? AuditActions.SCREENING_POOL_UPDATED
        : AuditActions.SCREENING_POOL_CREATED,
      previousValue: before
        ? {
            name: before.name,
            projectIds: before.members.map((member) => member.projectId),
          }
        : undefined,
      newValue: { name: pool.name, projectIds: orderedProjectIds },
      metadata: { guidelineId },
    });
    return { ...pool, picos: selected };
  });
}

export async function deleteGuidelineScreeningPool(
  ctx: Ctx,
  guidelineId: string,
) {
  await loadGuideline(ctx, guidelineId, "project.edit");
  return prisma.$transaction(async (tx) => {
    const familyStages = await tx.screeningStage.findMany({
      where: {
        project: { parentProjectId: guidelineId },
        type: "TITLE_ABSTRACT",
      },
      select: { id: true },
    });
    await lockScreeningStages(
      tx,
      familyStages.map((s) => s.id),
    );
    const pool = await tx.guidelineScreeningPool.findUnique({
      where: { guidelineId },
      include: { members: { orderBy: { order: "asc" } } },
    });
    if (!pool) throw notFound("Screening pool");
    await tx.guidelineScreeningPoolMember.deleteMany({
      where: { poolId: pool.id },
    });
    await tx.guidelineScreeningPool.delete({ where: { id: pool.id } });
    await audit.record(tx, {
      projectId: guidelineId,
      userId: ctx.userId,
      entityType: "GuidelineScreeningPool",
      entityId: pool.id,
      action: AuditActions.SCREENING_POOL_DELETED,
      previousValue: {
        name: pool.name,
        projectIds: pool.members.map((member) => member.projectId),
      },
      metadata: { guidelineId },
    });
    return { deleted: true, id: pool.id };
  });
}

async function loadGuidelinePoolSelection(
  ctx: Ctx,
  guidelineId: string,
  poolId: string,
  capability: Capability,
) {
  const guideline = await loadGuideline(ctx, guidelineId, capability);
  const pool = await prisma.guidelineScreeningPool.findFirst({
    where: { id: poolId, guidelineId },
    include: {
      members: {
        select: { projectId: true },
        orderBy: { order: "asc" },
      },
    },
  });
  if (!pool) throw notFound("Screening pool");

  const requested = new Set(pool.members.map((member) => member.projectId));
  const selected = guideline.subProjects.filter((project) =>
    requested.has(project.id),
  );
  if (selected.length !== requested.size) {
    throw invalidState(
      "This screening pool contains a project outside its guideline family",
    );
  }
  for (const project of selected) {
    await requirePermission(ctx, project.id, capability);
  }
  return {
    guideline: { id: guideline.id, title: guideline.title },
    pool: { id: pool.id, name: pool.name },
    selected,
  };
}

async function titleAbstractStages(
  projectIds: string[],
): Promise<ScreeningStage[]> {
  await Promise.all(projectIds.map((projectId) => ensureStages(projectId)));
  const stages = await prisma.screeningStage.findMany({
    where: { projectId: { in: projectIds }, type: "TITLE_ABSTRACT" },
  });
  if (stages.length !== projectIds.length)
    throw notFound("Title and abstract screening stage");
  assertCompatibleStages(stages);
  return stages;
}

function assertCompatibleStages(stages: ScreeningStage[]) {
  const reviewerCounts = new Set(
    stages.map((stage) => stage.reviewersPerCitation),
  );
  if (reviewerCounts.size !== 1) {
    throw invalidState(
      "Selected PICOs must use the same number of title/abstract reviewers before they can share a pooled queue",
    );
  }
  if (new Set(stages.map((s) => s.maybeGeneratesConflict)).size !== 1) {
    throw invalidState(
      "Selected PICOs must use the same Maybe conflict setting before they can share a pooled queue",
    );
  }
}

const pooledCitationSelect = {
  id: true,
  projectId: true,
  title: true,
  normalizedTitle: true,
  authors: true,
  year: true,
  journal: true,
  abstract: true,
  doi: true,
  pmid: true,
  url: true,
  createdAt: true,
  sourceRecords: {
    select: { batch: { select: { source: { select: { name: true } } } } },
  },
} satisfies Prisma.CitationSelect;

type PooledCitation = Prisma.CitationGetPayload<{
  select: typeof pooledCitationSelect;
}>;

function bestRepresentative(group: PooledCitation[]): PooledCitation {
  return [...group].sort((a, b) => {
    const abstractDifference =
      (b.abstract?.trim().length ?? 0) - (a.abstract?.trim().length ?? 0);
    if (abstractDifference !== 0) return abstractDifference;
    const identifierDifference =
      Number(Boolean(b.doi || b.pmid)) - Number(Boolean(a.doi || a.pmid));
    if (identifierDifference !== 0) return identifierDifference;
    const timeDifference = a.createdAt.getTime() - b.createdAt.getTime();
    return timeDifference !== 0 ? timeDifference : a.id.localeCompare(b.id);
  })[0]!;
}

function queueCitation(citation: PooledCitation) {
  return {
    id: citation.id,
    title: citation.title,
    authors: citation.authors,
    year: citation.year,
    journal: citation.journal,
    abstract: citation.abstract,
    doi: citation.doi,
    pmid: citation.pmid,
    url: citation.url,
    sources: [
      ...new Set(citation.sourceRecords.map((row) => row.batch.source.name)),
    ],
  };
}

export async function getPooledQueue(
  ctx: Ctx,
  guidelineId: string,
  input: z.input<typeof pooledNavigatorQuerySchema>,
) {
  const query = pooledNavigatorQuerySchema.parse(input);
  const family = await loadGuidelinePoolSelection(
    ctx,
    guidelineId,
    query.poolId,
    "screening.decide",
  );
  const membership = await prisma.projectMember.findUniqueOrThrow({
    where: { projectId_userId: { projectId: guidelineId, userId: ctx.userId } },
    select: { roles: true },
  });
  const isAdmin = can(membership.roles, "screening.configure");
  if (query.status === "ALL" && !isAdmin)
    throw forbidden("Only an Owner or Admin can browse all pooled abstracts");
  const projectIds = family.selected.map((p) => p.id);
  const stages = await titleAbstractStages(projectIds);
  const required = stages[0]!.reviewersPerCitation;
  return prisma.$transaction(
    async (tx) => {
      const [quota, states, reasons, searchMatches] = await Promise.all([
        quotaProgress(tx, { poolId: query.poolId }, ctx.userId),
        loadPooledState(
          tx,
          projectIds,
          stages.map((s) => s.id),
        ),
        tx.exclusionReason.findMany({
          where: {
            projectId: { in: projectIds },
            isActive: true,
            stage: { in: ["TITLE_ABSTRACT", "BOTH"] },
          },
          select: { projectId: true, label: true, order: true },
          orderBy: [{ order: "asc" }, { label: "asc" }],
        }),
        // Search every copy, then page logical groups. Parameterized literal substring search
        // includes JSON author names without loading the full corpus text into application memory.
        query.q
          ? tx.$queryRaw<{ id: string }[]>(Prisma.sql`
      SELECT "id" FROM "Citation"
      WHERE "projectId" IN (${Prisma.join(projectIds)}) AND "status" = 'ACTIVE'
      AND (strpos(lower("title"), lower(${query.q})) > 0
        OR strpos(lower(coalesce("abstract", '')), lower(${query.q})) > 0
        OR strpos(lower(coalesce("doi", '')), lower(${query.q})) > 0
        OR strpos(lower(coalesce("pmid", '')), lower(${query.q})) > 0
        OR strpos(lower(coalesce("authors"::text, '')), lower(${query.q})) > 0)
    `)
          : null,
      ]);
      const searchIds = searchMatches
        ? new Set(searchMatches.map((c) => c.id))
        : null;
      const classified = states.map((state) => ({
        state,
        personal: pooledReviewerState(state, ctx.userId, required, quota),
      }));
      const matches = classified.filter(
        ({ state }) =>
          !searchIds || state.group.some((c) => searchIds.has(c.id)),
      );
      const available = classified.filter(
        (row) => row.personal.available,
      ).length;
      const myReviewed = classified.filter(
        (row) => row.personal.hasReviewed,
      ).length;
      const filtered = matches.filter(
        ({ personal }) =>
          query.status === "ALL" ||
          (query.status === "AVAILABLE"
            ? personal.available
            : personal.hasReviewed),
      );
      const total = filtered.length;
      const totalPages = Math.max(1, Math.ceil(total / query.limit));
      const page = Math.min(query.page, totalPages);
      const pageStates = filtered.slice(
        (page - 1) * query.limit,
        page * query.limit,
      );
      const pageIds = pageStates.flatMap(({ state }) =>
        state.group.map((c) => c.id),
      );
      const hydrated = await tx.citation.findMany({
        where: { id: { in: pageIds } },
        select: pooledCitationSelect,
      });
      const citationById = new Map(hydrated.map((c) => [c.id, c]));
      const projectById = new Map(family.selected.map((p) => [p.id, p]));
      const labels = [...new Set(reasons.map((r) => r.label))];
      const commonReasons = labels
        .filter((label) =>
          projectIds.every((id) =>
            reasons.some((r) => r.projectId === id && r.label === label),
          ),
        )
        .map((label) => ({ label }));

      return {
        guideline: family.guideline,
        pool: family.pool,
        picos: family.selected,
        configuration: {
          reviewersPerCitation: required,
          blinded: stages.some((s) => s.blinded),
        },
        quota,
        summary: { available, myReviewed },
        // Pool health never depends on the logged-in reviewer's assignments or quota.
        adminSummary: isAdmin
          ? {
              pooledAbstracts: states.length,
              linkedCitationRecords: states.reduce(
                (sum, s) => sum + s.group.length,
                0,
              ),
              overlaps: states.filter(
                (s) => new Set(s.group.map((c) => c.projectId)).size > 1,
              ).length,
              finalized: states.filter((s) => s.finalOutcome !== null).length,
              fullyReviewed: states.filter(
                (s) =>
                  !s.needsSynchronization &&
                  !s.finalOutcome &&
                  s.reviewedBy.size >= required,
              ).length,
              needsAdditionalReviews: states.filter(
                (s) =>
                  !s.needsSynchronization &&
                  !s.finalOutcome &&
                  s.reviewedBy.size < required,
              ).length,
              unreviewed: states.filter(
                (s) =>
                  !s.needsSynchronization &&
                  !s.finalOutcome &&
                  s.reviewedBy.size === 0,
              ).length,
              needsSynchronization: states.filter((s) => s.needsSynchronization)
                .length,
            }
          : null,
        total,
        pagination: { page, limit: query.limit, total, totalPages },
        reasons: commonReasons,
        items: pageStates.map(({ state, personal }) => {
          const group = state.group.map((c) => citationById.get(c.id)!);
          const representative = bestRepresentative(group);
          const byProject = new Map<string, string[]>();
          for (const citation of group) {
            const ids = byProject.get(citation.projectId) ?? [];
            ids.push(citation.id);
            byProject.set(citation.projectId, ids);
          }
          return {
            id: state.id,
            citationIds: group.map((c) => c.id).sort(),
            citation: queueCitation(representative),
            picos: [...byProject.entries()]
              .map(([projectId, ids]) => ({
                ...projectById.get(projectId)!,
                citationIds: ids.sort(),
              }))
              .sort((a, b) => a.picoNumber - b.picoNumber),
            completedReviews: state.reviewedBy.size,
            requiredReviews: required,
            myDecision: personal.myDecision,
            finalOutcome: state.finalOutcome,
            canDecide: personal.available || personal.canRevise,
            needsSynchronization: state.needsSynchronization,
          };
        }),
      };
    },
    {
      isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead,
      timeout: 30_000,
    },
  );
}

export async function createPooledAssignments(
  ctx: Ctx,
  guidelineId: string,
  input: z.infer<typeof createPooledAssignmentsSchema>,
) {
  const family = await loadGuidelinePoolSelection(
    ctx,
    guidelineId,
    input.poolId,
    "screening.configure",
  );
  const orderedProjectIds = family.selected.map((project) => project.id);
  const stages = await titleAbstractStages(orderedProjectIds);
  const reviewersPerCitation = stages[0]!.reviewersPerCitation;
  const reviewerIds = [...new Set(input.reviewerIds)];
  if (input.strategy === "split" && reviewerIds.length < reviewersPerCitation) {
    throw invalidState(
      `Split assignment needs at least ${reviewersPerCitation} reviewers for this pooled queue`,
    );
  }

  return prisma.$transaction(async (tx) => {
    const members = await tx.projectMember.findMany({
      where: {
        projectId: { in: orderedProjectIds },
        userId: { in: reviewerIds },
        status: "ACTIVE",
      },
      select: { projectId: true, userId: true, roles: true },
    });
    const eligible = new Set(
      members
        .filter((member) => can(member.roles, "screening.decide"))
        .map((member) => `${member.projectId}:${member.userId}`),
    );
    const ineligible = reviewerIds.filter((reviewerId) =>
      orderedProjectIds.some(
        (projectId) => !eligible.has(`${projectId}:${reviewerId}`),
      ),
    );
    if (ineligible.length > 0) {
      throw validationError(
        "Every reviewer must be an active screening member of every selected PICO",
        { reviewerIds: ineligible },
      );
    }

    const citations = await tx.citation.findMany({
      where: { projectId: { in: orderedProjectIds }, status: "ACTIVE" },
      select: {
        id: true,
        projectId: true,
        doi: true,
        pmid: true,
        normalizedTitle: true,
        createdAt: true,
      },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    });
    const groups = groupPooledCitationRows(citations);
    const stageByProject = new Map(
      stages.map((stage) => [stage.projectId, stage]),
    );
    const pairsByProject = new Map<
      string,
      { stageId: string; citationId: string; reviewerId: string }[]
    >();
    let cursor = 0;
    for (const group of groups) {
      const assignedReviewers =
        input.strategy === "all"
          ? reviewerIds
          : Array.from(
              { length: reviewersPerCitation },
              (_, offset) =>
                reviewerIds[(cursor + offset) % reviewerIds.length]!,
            );
      if (input.strategy === "split") {
        cursor = (cursor + reviewersPerCitation) % reviewerIds.length;
      }
      for (const citation of group) {
        const stage = stageByProject.get(citation.projectId)!;
        const projectPairs = pairsByProject.get(citation.projectId) ?? [];
        for (const reviewerId of assignedReviewers) {
          projectPairs.push({
            stageId: stage.id,
            citationId: citation.id,
            reviewerId,
          });
        }
        pairsByProject.set(citation.projectId, projectPairs);
      }
    }

    let created = 0;
    let requested = 0;
    for (const projectId of orderedProjectIds) {
      const pairs = pairsByProject.get(projectId) ?? [];
      const result = await tx.screeningAssignment.createMany({
        data: pairs,
        skipDuplicates: true,
      });
      created += result.count;
      requested += pairs.length;
      const stage = stageByProject.get(projectId)!;
      await audit.record(tx, {
        projectId,
        userId: ctx.userId,
        entityType: "ScreeningStage",
        entityId: stage.id,
        action: AuditActions.SCREENING_ASSIGNED,
        metadata: {
          strategy: input.strategy,
          pooledGuidelineId: guidelineId,
          pooledScreeningPoolId: family.pool.id,
          pooledScreeningPoolName: family.pool.name,
          pooledProjectIds: orderedProjectIds,
          reviewers: reviewerIds.length,
          eligibleAbstracts: groups.length,
          requested: pairs.length,
          created: result.count,
          skippedExisting: pairs.length - result.count,
        },
      });
    }

    return {
      created,
      skippedExisting: requested - created,
      eligibleAbstracts: groups.length,
      linkedCitationRecords: citations.length,
    };
  });
}

export async function createPooledDecision(
  ctx: Ctx,
  guidelineId: string,
  input: z.infer<typeof createPooledDecisionSchema>,
) {
  input = createPooledDecisionSchema.parse(input);
  const family = await loadGuidelinePoolSelection(
    ctx,
    guidelineId,
    input.poolId,
    "screening.decide",
  );
  const orderedProjectIds = family.selected.map((project) => project.id);
  const stages = await titleAbstractStages(orderedProjectIds);

  return prisma.$transaction(async (tx) => {
    for (const projectId of [...orderedProjectIds].sort()) {
      await tx.$queryRaw`SELECT "id" FROM "Project" WHERE "id" = ${projectId} FOR NO KEY UPDATE`;
    }
    await lockScreeningStages(
      tx,
      stages.map((stage) => stage.id),
    );
    await requirePermission(ctx, guidelineId, "screening.decide", tx);
    const quota = await quotaProgress(tx, { poolId: input.poolId }, ctx.userId);
    const currentMembers = await tx.guidelineScreeningPoolMember.findMany({
      where: { poolId: input.poolId },
    });
    if (
      currentMembers.length !== orderedProjectIds.length ||
      currentMembers.some((m) => !orderedProjectIds.includes(m.projectId))
    ) {
      throw invalidState(
        "This screening pool changed. Refresh the queue before deciding.",
      );
    }
    const currentStages = await tx.screeningStage.findMany({
      where: { id: { in: stages.map((s) => s.id) } },
    });
    assertCompatibleStages(currentStages);
    const states = await loadPooledState(
      tx,
      orderedProjectIds,
      currentStages.map((s) => s.id),
    );
    const requestedIds = new Set(input.citationIds);
    const state = states.find((s) =>
      s.group.some((c) => requestedIds.has(c.id)),
    );
    if (
      !state ||
      state.group.length !== requestedIds.size ||
      state.group.some((c) => !requestedIds.has(c.id))
    ) {
      throw invalidState(
        "This pooled abstract changed after it was loaded. Refresh the queue before deciding.",
      );
    }
    const group = state.group;
    if (state.needsSynchronization) {
      throw invalidState(
        "This abstract needs synchronization across its linked PICOs. Choose another abstract and ask an administrator to review the linked screening state.",
      );
    }
    const personal = pooledReviewerState(
      state,
      ctx.userId,
      currentStages[0]!.reviewersPerCitation,
      quota,
    );
    if (
      !personal.hasReviewed &&
      (state.finalOutcome ||
        state.reviewedBy.size >= currentStages[0]!.reviewersPerCitation)
    ) {
      throw invalidState(
        "This abstract has just received all required reviews. Choose another abstract.",
      );
    }
    if (state.finalOutcome)
      throw invalidState(
        "This abstract has a final stage outcome. An administrator must reopen every linked record before revision.",
      );
    if (!personal.hasReviewed && quota?.remaining === 0)
      throw invalidState("Your review quota is complete");
    if (!personal.available && !personal.canRevise)
      throw forbidden(
        "You need a reviewer quota or live fixed assignments across every linked PICO to screen this abstract",
      );

    const reasonByProject = new Map<string, string>();
    if (input.decision === "EXCLUDE") {
      if (!input.exclusionReasonLabel) {
        throw validationError(
          "Pooled title/abstract exclusions require a common reason subgroup",
        );
      }
      const reasons = await tx.exclusionReason.findMany({
        where: {
          projectId: { in: orderedProjectIds },
          label: input.exclusionReasonLabel,
          isActive: true,
          stage: { in: ["TITLE_ABSTRACT", "BOTH"] },
        },
        select: { id: true, projectId: true },
      });
      for (const reason of reasons)
        reasonByProject.set(reason.projectId, reason.id);
      if (
        orderedProjectIds.some((projectId) => !reasonByProject.has(projectId))
      ) {
        throw validationError(
          "The selected exclusion reason must be active in every PICO in this pooled queue",
        );
      }
    }

    const stageByProject = new Map(
      currentStages.map((stage) => [stage.projectId, stage]),
    );
    const metadata = {
      pooledGuidelineId: guidelineId,
      pooledScreeningPoolId: family.pool.id,
      pooledScreeningPoolName: family.pool.name,
      pooledProjectIds: orderedProjectIds,
      pooledCitationIds: group.map((citation) => citation.id).sort(),
    };
    const writes = [];
    for (const citation of group) {
      const stage = stageByProject.get(citation.projectId)!;
      writes.push(
        await createDecisionInTransaction(
          tx,
          ctx,
          citation.projectId,
          stage,
          {
            citationId: citation.id,
            decision: input.decision,
            exclusionReasonId: reasonByProject.get(citation.projectId) ?? null,
            notes: input.notes,
            labels: [],
            flaggedForDiscussion: false,
          },
          metadata,
          quota !== null,
        ),
      );
    }

    return {
      decision: input.decision,
      appliedToCitationRecords: writes.length,
      appliedToPicos: new Set(group.map((citation) => citation.projectId)).size,
      results: writes.map((write) => write.result),
    };
  });
}
