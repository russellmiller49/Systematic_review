// Screening service — stages, assignments, queue, decisions, blinding, conflicts,
// adjudication, stage results, reopen. Implements the lifecycle contract in docs/09:
//   R3 (materialized CitationStageResult; FT pool = TA INCLUDE results)
//   R5 (decision mutability lock; reopen)
//   R6 (conflict evaluation on every decision write, same transaction)
//   R7 (MAYBE semantics; unanimous MAYBE always conflicts)

import { z } from "zod";
import { Prisma, type ProjectMember, type ScreeningStage } from "@prisma/client";
import { prisma, type Tx } from "@/server/db";
import { forbidden, invalidState, notFound, validationError } from "@/server/errors";
import type { Ctx } from "@/server/auth/session";
import { can, getMembership, requirePermission } from "@/server/permissions";
import * as audit from "@/server/services/audit";
import { AuditActions } from "@/server/services/audit";
import { screeningKeywordCitationWhere } from "@/server/services/screening-keywords";
import * as studies from "@/server/services/studies";

// ---------------------------------------------------------------------------
// Zod schemas (imported by the route handlers)
// ---------------------------------------------------------------------------

export const updateStageSchema = z.object({
  reviewersPerCitation: z.number().int().min(1).max(3).optional(),
  blinded: z.boolean().optional(),
  maybeGeneratesConflict: z.boolean().optional(),
  aiShowScores: z.boolean().optional(),
  aiRankingEnabled: z.boolean().optional(),
});

export const createAssignmentsSchema = z.object({
  reviewerIds: z.array(z.string().min(1)).min(1).max(50),
  strategy: z.enum(["all", "split"]),
  citationIds: z.array(z.string().min(1)).optional(),
});

export const resetPendingAssignmentsSchema = z.object({
  reviewerIds: z.array(z.string().min(1)).min(1).max(50).optional(),
  reason: z.string().trim().min(3).max(2000),
});

export const createDecisionSchema = z.object({
  citationId: z.string().min(1),
  decision: z.enum(["INCLUDE", "EXCLUDE", "MAYBE"]),
  exclusionReasonId: z.string().min(1).nullable().optional(),
  notes: z.string().max(20_000).nullable().optional(),
  labels: z.array(z.string().trim().min(1).max(100)).max(25).optional(),
  flaggedForDiscussion: z.boolean().optional(),
});

export const batchExcludeSchema = z.object({
  citationIds: z
    .array(z.string().min(1))
    .min(1, "Choose at least one citation")
    .max(50, "You can exclude up to 50 citations at once")
    .refine((ids) => new Set(ids).size === ids.length, "Citations must be unique"),
  exclusionReasonId: z.string().min(1),
});

export const listDecisionsQuerySchema = z.object({
  citationId: z.string().min(1),
});

export const queueQuerySchema = z.object({
  keywordGroup: z.string().trim().min(1).max(200).optional(),
});

export type QueueQuery = z.infer<typeof queueQuerySchema>;

export const screeningNavigatorQuerySchema = z.object({
  q: z.string().trim().max(500).optional(),
  keywordGroup: z.string().trim().min(1).max(200).optional(),
  status: z
    .enum(["ALL", "UNDECIDED", "DECIDED", "ONE_REVIEWER", "INCLUDED", "EXCLUDED"])
    .default("UNDECIDED"),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

export type ScreeningNavigatorQuery = z.infer<typeof screeningNavigatorQuerySchema>;

export const listConflictsQuerySchema = z.object({
  stage: z.enum(["TITLE_ABSTRACT", "FULL_TEXT"]).optional(),
  status: z.enum(["OPEN", "RESOLVED", "VOIDED"]).optional(),
});

export const adminOverviewQuerySchema = z.object({
  q: z.string().trim().max(500).optional(),
  keywordGroup: z.string().trim().min(1).max(200).optional(),
  status: z
    .enum([
      "ALL",
      "UNASSIGNED",
      "NOT_STARTED",
      "IN_PROGRESS",
      "CONFLICT",
      "INCLUDED",
      "EXCLUDED",
    ])
    .default("ALL"),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(25),
});

export type AdminOverviewQuery = z.infer<typeof adminOverviewQuerySchema>;

// R7: adjudication is restricted to a decisive outcome.
export const adjudicateSchema = z.object({
  finalDecision: z.enum(["INCLUDE", "EXCLUDE"]),
  exclusionReasonId: z.string().min(1).nullable().optional(),
  reason: z.string().trim().min(3).max(20_000),
});

export const reopenSchema = z.object({
  stageType: z.enum(["TITLE_ABSTRACT", "FULL_TEXT"]),
  reason: z.string().trim().min(3).max(20_000),
});

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

// R9: by-id stage load is tenant-scoped.
async function getStageOr404(tx: Tx, projectId: string, stageId: string) {
  const stage = await tx.screeningStage.findFirst({ where: { id: stageId, projectId } });
  if (!stage) throw notFound("Screening stage");
  return stage;
}

// A PICO inside a persisted guideline pool has one authoritative title/abstract entry point.
// The pooled service calls createDecisionInTransaction directly after resolving the pool;
// ordinary queue/assignment/decision endpoints are blocked to prevent partial, out-of-sync work.
async function assertIndividualTitleAbstractAllowed(tx: Tx, stage: ScreeningStage) {
  if (stage.type !== "TITLE_ABSTRACT") return;
  const membership = await tx.guidelineScreeningPoolMember.findUnique({
    where: { projectId: stage.projectId },
    select: { pool: { select: { name: true } } },
  });
  if (membership) {
    throw invalidState(
      `This PICO is screened through the combined pool "${membership.pool.name}". Open screening from the guideline workspace.`,
    );
  }
}

// The citation "card" shown to screeners/adjudicators.
const citationCardInclude = {
  identifiers: { select: { type: true, value: true } },
  sourceRecords: {
    select: { batch: { select: { source: { select: { name: true } } } } },
  },
} satisfies Prisma.CitationInclude;

type CitationWithCard = Prisma.CitationGetPayload<{ include: typeof citationCardInclude }>;

function citationCard(citation: CitationWithCard) {
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
    identifiers: citation.identifiers,
    sources: [...new Set(citation.sourceRecords.map((r) => r.batch.source.name))],
  };
}

const decisionInclude = {
  reviewer: { select: { id: true, name: true } },
  exclusionReason: { select: { id: true, label: true, stage: true } },
} satisfies Prisma.ScreeningDecisionInclude;

// Validates an exclusion reason id for a stage: must belong to the project, be active,
// and apply to the stage (FULL_TEXT stage takes FULL_TEXT|BOTH reasons, etc.). R9.
async function validateExclusionReason(
  tx: Tx,
  projectId: string,
  stageType: ScreeningStage["type"],
  exclusionReasonId: string,
) {
  const allowed =
    stageType === "FULL_TEXT"
      ? (["FULL_TEXT", "BOTH"] as const)
      : (["TITLE_ABSTRACT", "BOTH"] as const);
  const reason = await tx.exclusionReason.findFirst({
    where: { id: exclusionReasonId, projectId, isActive: true, stage: { in: [...allowed] } },
  });
  if (!reason) {
    throw validationError(
      "Exclusion reason not found, inactive, or not applicable to this stage",
    );
  }
  return reason;
}

// ---------------------------------------------------------------------------
// 1. Stages
// ---------------------------------------------------------------------------

const STAGE_TYPES = ["TITLE_ABSTRACT", "FULL_TEXT"] as const;

// Stages are per-project config rows (unique on projectId+type). They are lazily created
// with schema defaults on first read so screening works regardless of when project setup
// ran; the unique constraint makes concurrent creation safe.
export async function ensureStages(projectId: string) {
  const existing = await prisma.screeningStage.findMany({ where: { projectId } });
  const missing = STAGE_TYPES.filter((t) => !existing.some((s) => s.type === t));
  for (const type of missing) {
    try {
      await prisma.screeningStage.create({ data: { projectId, type } });
    } catch {
      // Unique(projectId, type) race with another request/agent — the row exists; fine.
    }
  }
  const stages = await prisma.screeningStage.findMany({ where: { projectId } });
  return stages.sort(
    (a, b) => STAGE_TYPES.indexOf(a.type) - STAGE_TYPES.indexOf(b.type),
  );
}

export async function listStages(ctx: Ctx, projectId: string) {
  await requirePermission(ctx, projectId, "project.view");
  const stages = await ensureStages(projectId);
  return Promise.all(
    stages.map(async (stage) => {
      // R8: all progress queries only count ACTIVE citations.
      const [assigned, decided, openConflicts, included, excluded] = await Promise.all([
        prisma.screeningAssignment.findMany({
          where: {
            stageId: stage.id,
            status: { not: "VOIDED" },
            citation: { status: "ACTIVE" },
          },
          distinct: ["citationId"],
          select: { citationId: true },
        }),
        prisma.screeningDecision.findMany({
          where: { stageId: stage.id, citation: { status: "ACTIVE" } },
          distinct: ["citationId"],
          select: { citationId: true },
        }),
        prisma.screeningConflict.count({
          where: { stageId: stage.id, status: "OPEN", citation: { status: "ACTIVE" } },
        }),
        prisma.citationStageResult.count({
          where: { stageId: stage.id, outcome: "INCLUDE", citation: { status: "ACTIVE" } },
        }),
        prisma.citationStageResult.count({
          where: { stageId: stage.id, outcome: "EXCLUDE", citation: { status: "ACTIVE" } },
        }),
      ]);
      return {
        ...stage,
        progress: {
          assignedCitations: assigned.length,
          decidedCitations: decided.length,
          openConflicts,
          results: { total: included + excluded, included, excluded },
        },
      };
    }),
  );
}

export async function updateStage(
  ctx: Ctx,
  projectId: string,
  stageId: string,
  input: z.infer<typeof updateStageSchema>,
) {
  await requirePermission(ctx, projectId, "screening.configure");
  return prisma.$transaction(async (tx) => {
    const stage = await getStageOr404(tx, projectId, stageId);
    const unblinding = input.blinded === false && stage.blinded === true;
    const updated = await tx.screeningStage.update({
      where: { id: stage.id },
      data: { ...input, ...(unblinding ? { unblindedAt: new Date() } : {}) },
    });
    await audit.record(tx, {
      projectId,
      userId: ctx.userId,
      entityType: "ScreeningStage",
      entityId: stage.id,
      action: unblinding
        ? AuditActions.SCREENING_STAGE_UNBLINDED
        : AuditActions.SCREENING_STAGE_UPDATED,
      previousValue: {
        reviewersPerCitation: stage.reviewersPerCitation,
        blinded: stage.blinded,
        maybeGeneratesConflict: stage.maybeGeneratesConflict,
        aiShowScores: stage.aiShowScores,
        aiRankingEnabled: stage.aiRankingEnabled,
      },
      newValue: {
        reviewersPerCitation: updated.reviewersPerCitation,
        blinded: updated.blinded,
        maybeGeneratesConflict: updated.maybeGeneratesConflict,
        aiShowScores: updated.aiShowScores,
        aiRankingEnabled: updated.aiRankingEnabled,
      },
    });
    return updated;
  });
}

// ---------------------------------------------------------------------------
// 2. Assignments & queue
// ---------------------------------------------------------------------------

export async function createAssignments(
  ctx: Ctx,
  projectId: string,
  stageId: string,
  input: z.infer<typeof createAssignmentsSchema>,
) {
  await requirePermission(ctx, projectId, "screening.configure");
  return prisma.$transaction(async (tx) => {
    const stage = await getStageOr404(tx, projectId, stageId);
    await assertIndividualTitleAbstractAllowed(tx, stage);
    const reviewerIds = [...new Set(input.reviewerIds)];

    // Reviewers must be ACTIVE project members holding screening.decide.
    const members = await tx.projectMember.findMany({
      where: { projectId, userId: { in: reviewerIds }, status: "ACTIVE" },
    });
    const byUser = new Map(members.map((m) => [m.userId, m]));
    const ineligible = reviewerIds.filter((id) => {
      const m = byUser.get(id);
      return !m || !can(m.roles, "screening.decide");
    });
    if (ineligible.length > 0) {
      throw validationError(
        "Some reviewers are not active project members with screening permission",
        { reviewerIds: ineligible },
      );
    }

    // Eligible citation pool: ACTIVE citations of this project (intersected with the
    // explicit citationIds when given). R3: FULL_TEXT may only target citations with an
    // INCLUDE stage result at TITLE_ABSTRACT.
    const citationWhere: Prisma.CitationWhereInput = { projectId, status: "ACTIVE" };
    if (input.citationIds && input.citationIds.length > 0) {
      citationWhere.id = { in: input.citationIds };
    }
    if (stage.type === "FULL_TEXT") {
      const taStage = await tx.screeningStage.findUnique({
        where: { projectId_type: { projectId, type: "TITLE_ABSTRACT" } },
      });
      if (!taStage) {
        throw invalidState(
          "Full-text assignment requires a title/abstract stage with INCLUDE results",
        );
      }
      citationWhere.stageResults = { some: { stageId: taStage.id, outcome: "INCLUDE" } };
    }
    const citations = await tx.citation.findMany({
      where: citationWhere,
      select: { id: true },
      orderBy: { createdAt: "asc" },
    });

    const pairs: { citationId: string; reviewerId: string }[] = [];
    if (input.strategy === "all") {
      for (const citation of citations) {
        for (const reviewerId of reviewerIds) {
          pairs.push({ citationId: citation.id, reviewerId });
        }
      }
    } else {
      // split: round-robin so each citation gets exactly reviewersPerCitation distinct
      // reviewers (consecutive offsets mod reviewerIds.length are distinct).
      if (reviewerIds.length < stage.reviewersPerCitation) {
        throw invalidState(
          `Split assignment needs at least ${stage.reviewersPerCitation} reviewers for this stage`,
        );
      }
      let cursor = 0;
      for (const citation of citations) {
        for (let k = 0; k < stage.reviewersPerCitation; k++) {
          pairs.push({
            citationId: citation.id,
            reviewerId: reviewerIds[(cursor + k) % reviewerIds.length]!,
          });
        }
        cursor = (cursor + stage.reviewersPerCitation) % reviewerIds.length;
      }
    }

    // Skip existing (stage, citation, reviewer) rows — including VOIDED ones.
    const result = await tx.screeningAssignment.createMany({
      data: pairs.map((p) => ({ stageId: stage.id, ...p })),
      skipDuplicates: true,
    });

    await audit.record(tx, {
      projectId,
      userId: ctx.userId,
      entityType: "ScreeningStage",
      entityId: stage.id,
      action: AuditActions.SCREENING_ASSIGNED,
      metadata: {
        strategy: input.strategy,
        reviewers: reviewerIds.length,
        eligibleCitations: citations.length,
        requested: pairs.length,
        created: result.count,
        skippedExisting: pairs.length - result.count,
      },
    });

    return {
      created: result.count,
      skippedExisting: pairs.length - result.count,
      eligibleCitations: citations.length,
    };
  });
}

// Admin workload view. It intentionally exposes counts and assignee identity only — never
// blinded decision content. OWNER/ADMIN hold screening.configure.
export async function listAssignmentAdmin(
  ctx: Ctx,
  projectId: string,
  stageId: string,
) {
  await requirePermission(ctx, projectId, "screening.configure");
  const stage = await getStageOr404(prisma, projectId, stageId);

  const grouped = await prisma.screeningAssignment.groupBy({
    by: ["reviewerId", "status"],
    where: { stageId: stage.id, status: { not: "VOIDED" } },
    _count: { _all: true },
  });
  const decisionGroups = await prisma.screeningDecision.groupBy({
    by: ["reviewerId"],
    where: { stageId: stage.id },
    _count: { _all: true },
  });
  const reviewerIds = [...new Set(grouped.map((row) => row.reviewerId))];
  const users = reviewerIds.length
    ? await prisma.user.findMany({
        where: { id: { in: reviewerIds } },
        select: { id: true, name: true, email: true },
      })
    : [];
  const members = reviewerIds.length
    ? await prisma.projectMember.findMany({
        where: { projectId, userId: { in: reviewerIds } },
        select: { userId: true, roles: true, status: true },
      })
    : [];

  const userById = new Map(users.map((user) => [user.id, user]));
  const memberById = new Map(members.map((member) => [member.userId, member]));
  const decisionsById = new Map(
    decisionGroups.map((row) => [row.reviewerId, row._count._all]),
  );
  const countsById = new Map<
    string,
    { pending: number; completed: number; assignments: number }
  >();
  for (const row of grouped) {
    const counts = countsById.get(row.reviewerId) ?? {
      pending: 0,
      completed: 0,
      assignments: 0,
    };
    counts.assignments += row._count._all;
    if (row.status === "PENDING") counts.pending += row._count._all;
    if (row.status === "COMPLETED") counts.completed += row._count._all;
    countsById.set(row.reviewerId, counts);
  }

  const reviewers = reviewerIds
    .map((reviewerId) => {
      const counts = countsById.get(reviewerId)!;
      const member = memberById.get(reviewerId);
      return {
        reviewer: userById.get(reviewerId) ?? {
          id: reviewerId,
          name: "Former member",
          email: "",
        },
        roles: member?.roles ?? [],
        memberStatus: member?.status ?? "REMOVED",
        assignments: counts.assignments,
        pending: counts.pending,
        completed: counts.completed,
        decisions: decisionsById.get(reviewerId) ?? 0,
      };
    })
    .sort((a, b) => a.reviewer.name.localeCompare(b.reviewer.name));

  return {
    stage: {
      id: stage.id,
      type: stage.type,
      reviewersPerCitation: stage.reviewersPerCitation,
    },
    totals: {
      assignments: reviewers.reduce((sum, row) => sum + row.assignments, 0),
      pending: reviewers.reduce((sum, row) => sum + row.pending, 0),
      completed: reviewers.reduce((sum, row) => sum + row.completed, 0),
      decisions: reviewers.reduce((sum, row) => sum + row.decisions, 0),
    },
    reviewers,
  };
}

// Removes only PENDING assignments with no corresponding decision. Completed work is
// protected by construction, even if a caller asks to reset the entire stage.
export async function resetPendingAssignments(
  ctx: Ctx,
  projectId: string,
  stageId: string,
  input: z.infer<typeof resetPendingAssignmentsSchema>,
) {
  await requirePermission(ctx, projectId, "screening.configure");
  return prisma.$transaction(async (tx) => {
    const stage = await getStageOr404(tx, projectId, stageId);
    const reviewerIds = input.reviewerIds ? [...new Set(input.reviewerIds)] : undefined;

    if (reviewerIds) {
      const known = await tx.projectMember.count({
        where: { projectId, userId: { in: reviewerIds } },
      });
      if (known !== reviewerIds.length) {
        throw validationError("Some reviewers do not belong to this project");
      }
    }

    const reviewerFilter = reviewerIds
      ? Prisma.sql`AND assignment."reviewerId" IN (${Prisma.join(reviewerIds)})`
      : Prisma.empty;
    const before = await tx.screeningAssignment.count({
      where: {
        stageId: stage.id,
        status: { not: "VOIDED" },
        ...(reviewerIds ? { reviewerId: { in: reviewerIds } } : {}),
      },
    });

    const removed = await tx.$queryRaw<{ id: string; reviewerId: string }[]>(Prisma.sql`
      DELETE FROM "ScreeningAssignment" AS assignment
      WHERE assignment."stageId" = ${stage.id}
        AND assignment."status" = 'PENDING'
        ${reviewerFilter}
        AND NOT EXISTS (
          SELECT 1
          FROM "ScreeningDecision" AS decision
          WHERE decision."stageId" = assignment."stageId"
            AND decision."citationId" = assignment."citationId"
            AND decision."reviewerId" = assignment."reviewerId"
        )
      RETURNING assignment."id", assignment."reviewerId"
    `);

    const remaining = await tx.screeningAssignment.count({
      where: {
        stageId: stage.id,
        status: { not: "VOIDED" },
        ...(reviewerIds ? { reviewerId: { in: reviewerIds } } : {}),
      },
    });
    const affectedReviewerIds = [...new Set(removed.map((row) => row.reviewerId))];

    if (removed.length > 0) {
      await audit.record(tx, {
        projectId,
        userId: ctx.userId,
        entityType: "ScreeningStage",
        entityId: stage.id,
        action: AuditActions.SCREENING_ASSIGNMENTS_RESET,
        previousValue: { assignmentCount: before },
        newValue: { assignmentCount: remaining },
        reason: input.reason,
        metadata: {
          stageType: stage.type,
          scope: reviewerIds ? "selected_reviewers" : "all_reviewers",
          requestedReviewerIds: reviewerIds ?? null,
          affectedReviewerIds,
          deletedPendingAssignments: removed.length,
          protectedAssignments: before - removed.length,
        },
      });
    }

    return {
      deleted: removed.length,
      protectedAssignments: before - removed.length,
      remainingAssignments: remaining,
      affectedReviewerIds,
    };
  });
}

type QueueAssignment = Prisma.ScreeningAssignmentGetPayload<{
  include: { citation: { include: typeof citationCardInclude } };
}>;

// My pending work at a stage. Blind-safe by construction: the payload only ever contains
// MY decision data — never other reviewers' decisions. AI suggestions (ScreeningSuggestion)
// carry no reviewer data, so surfacing them here cannot leak votes.
export async function getQueue(
  ctx: Ctx,
  projectId: string,
  stageId: string,
  query: QueueQuery = {},
) {
  await requirePermission(ctx, projectId, "screening.decide");
  const stage = await getStageOr404(prisma, projectId, stageId);
  await assertIndividualTitleAbstractAllowed(prisma, stage);
  const keywordWhere = await screeningKeywordCitationWhere(
    prisma,
    projectId,
    query.keywordGroup,
  );
  const citationWhere: Prisma.CitationWhereInput = {
    status: "ACTIVE",
    // Settled citations (a stage result exists) leave the queue even if my own
    // assignment is still PENDING (e.g. 3 assignees, reviewersPerCitation=2).
    stageResults: { none: { stageId: stage.id } },
  };
  const where: Prisma.ScreeningAssignmentWhereInput = {
    stageId: stage.id,
    reviewerId: ctx.userId,
    status: "PENDING",
    citation: keywordWhere ? { AND: [citationWhere, keywordWhere] } : citationWhere,
  };

  const total = await prisma.screeningAssignment.count({ where });
  let assignments: QueueAssignment[];
  if (stage.aiRankingEnabled) {
    // Rank by AI score (desc, unscored last), tie-broken FIFO. Sort over a slim projection
    // of ALL pending assignments; only the top page loads full citation cards.
    const slim = await prisma.screeningAssignment.findMany({
      where,
      select: { id: true, citationId: true, createdAt: true },
    });
    const scores = await prisma.screeningSuggestion.findMany({
      where: { stageId: stage.id, citationId: { in: slim.map((a) => a.citationId) } },
      select: { citationId: true, score: true },
    });
    const scoreByCitation = new Map(scores.map((s) => [s.citationId, s.score]));
    slim.sort((a, b) => {
      const sa = scoreByCitation.get(a.citationId);
      const sb = scoreByCitation.get(b.citationId);
      if (sa !== undefined && sb !== undefined && sa !== sb) return sb - sa;
      if ((sa !== undefined) !== (sb !== undefined)) return sa !== undefined ? -1 : 1;
      const dt = a.createdAt.getTime() - b.createdAt.getTime();
      if (dt !== 0) return dt;
      return a.id < b.id ? -1 : 1;
    });
    const pageIds = slim.slice(0, 25).map((a) => a.id);
    const loaded = await prisma.screeningAssignment.findMany({
      where: { id: { in: pageIds } },
      include: { citation: { include: citationCardInclude } },
    });
    const byId = new Map(loaded.map((a) => [a.id, a]));
    assignments = pageIds
      .map((id) => byId.get(id))
      .filter((a): a is QueueAssignment => a !== undefined);
  } else {
    assignments = await prisma.screeningAssignment.findMany({
      where,
      take: 25,
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      include: { citation: { include: citationCardInclude } },
    });
  }

  const citationIds = assignments.map((a) => a.citationId);
  const [myDecisions, visibleSuggestions] = await Promise.all([
    prisma.screeningDecision.findMany({
      where: { stageId: stage.id, reviewerId: ctx.userId, citationId: { in: citationIds } },
      include: decisionInclude,
    }),
    // Scores reach screeners only when the stage's aiShowScores toggle is on.
    stage.aiShowScores
      ? prisma.screeningSuggestion.findMany({
          where: { stageId: stage.id, citationId: { in: citationIds } },
          select: { citationId: true, score: true, suggestedDecision: true, rationale: true },
        })
      : Promise.resolve([]),
  ]);
  const decisionByCitation = new Map(myDecisions.map((d) => [d.citationId, d]));
  const suggestionByCitation = new Map(visibleSuggestions.map((s) => [s.citationId, s]));
  return {
    stage: { id: stage.id, type: stage.type },
    total,
    items: assignments.map((a) => {
      const suggestion = suggestionByCitation.get(a.citationId);
      return {
        assignmentId: a.id,
        citation: citationCard(a.citation),
        myDecision: decisionByCitation.get(a.citationId) ?? null,
        aiSuggestion: suggestion
          ? {
              score: suggestion.score,
              suggestedDecision: suggestion.suggestedDecision,
              rationale: suggestion.rationale,
            }
          : null,
      };
    }),
  };
}

function navigatorStatusWhere(
  stageId: string,
  reviewerId: string,
  status: ScreeningNavigatorQuery["status"],
  oneReviewerCitationIds: string[],
): Prisma.CitationWhereInput | undefined {
  switch (status) {
    case "UNDECIDED":
      return {
        assignments: {
          some: { stageId, reviewerId, status: "PENDING" },
        },
        stageResults: { none: { stageId } },
      };
    case "DECIDED":
      return { decisions: { some: { stageId, reviewerId } } };
    case "ONE_REVIEWER":
      return {
        id: { in: oneReviewerCitationIds },
        stageResults: { none: { stageId } },
      };
    case "INCLUDED":
      return { stageResults: { some: { stageId, outcome: "INCLUDE" } } };
    case "EXCLUDED":
      return { stageResults: { some: { stageId, outcome: "EXCLUDE" } } };
    case "ALL":
      return undefined;
  }
}

// Blind-safe article navigator for a reviewer's assigned corpus. It exposes only the
// reviewer's own decision, aggregate completion counts, and materialized final outcomes.
// In particular, ONE_REVIEWER never carries the first reviewer's choice or identity.
export async function getScreeningNavigator(
  ctx: Ctx,
  projectId: string,
  stageId: string,
  query: ScreeningNavigatorQuery,
) {
  await requirePermission(ctx, projectId, "screening.decide");
  const stage = await getStageOr404(prisma, projectId, stageId);
  await assertIndividualTitleAbstractAllowed(prisma, stage);
  const keywordWhere = await screeningKeywordCitationWhere(
    prisma,
    projectId,
    query.keywordGroup,
  );

  const basePredicates: Prisma.CitationWhereInput[] = [
    {
      projectId,
      status: "ACTIVE",
      assignments: {
        some: {
          stageId: stage.id,
          reviewerId: ctx.userId,
          status: { not: "VOIDED" },
        },
      },
    },
  ];
  if (query.q) {
    basePredicates.push({
      OR: [
        { title: { contains: query.q, mode: "insensitive" } },
        { abstract: { contains: query.q, mode: "insensitive" } },
      ],
    });
  }
  if (keywordWhere) basePredicates.push(keywordWhere);
  const baseWhere: Prisma.CitationWhereInput = { AND: basePredicates };

  // A "review" is a completed, still-live assignment. Use aggregate counts only; no
  // reviewer identity or decision value crosses this endpoint.
  const completedGroups = await prisma.screeningAssignment.groupBy({
    by: ["citationId"],
    where: {
      stageId: stage.id,
      status: "COMPLETED",
      citation: { status: "ACTIVE" },
    },
    _count: { _all: true },
  });
  const oneReviewerCitationIds = completedGroups
    .filter((group) => group._count._all === 1)
    .map((group) => group.citationId);

  const statusWhere = navigatorStatusWhere(
    stage.id,
    ctx.userId,
    query.status,
    oneReviewerCitationIds,
  );
  const filteredWhere: Prisma.CitationWhereInput = statusWhere
    ? { AND: [baseWhere, statusWhere] }
    : baseWhere;
  const countFor = (status: Exclude<ScreeningNavigatorQuery["status"], "ALL">) =>
    prisma.citation.count({
      where: {
        AND: [
          baseWhere,
          navigatorStatusWhere(
            stage.id,
            ctx.userId,
            status,
            oneReviewerCitationIds,
          )!,
        ],
      },
    });

  const [total, all, undecided, decided, oneReviewer, included, excluded] =
    await Promise.all([
      prisma.citation.count({ where: filteredWhere }),
      prisma.citation.count({ where: baseWhere }),
      countFor("UNDECIDED"),
      countFor("DECIDED"),
      countFor("ONE_REVIEWER"),
      countFor("INCLUDED"),
      countFor("EXCLUDED"),
    ]);

  const totalPages = Math.max(1, Math.ceil(total / query.limit));
  const page = Math.min(query.page, totalPages);
  const include = {
    ...citationCardInclude,
    assignments: {
      where: {
        stageId: stage.id,
        reviewerId: ctx.userId,
        status: { not: "VOIDED" as const },
      },
      select: { id: true, status: true },
      take: 1,
    },
    decisions: {
      where: { stageId: stage.id, reviewerId: ctx.userId },
      select: { decision: true, notes: true },
      take: 1,
    },
    stageResults: {
      where: { stageId: stage.id },
      select: { outcome: true },
      take: 1,
    },
    _count: {
      select: {
        assignments: {
          where: { stageId: stage.id, status: "COMPLETED" as const },
        },
      },
    },
  } satisfies Prisma.CitationInclude;

  type NavigatorCitation = Prisma.CitationGetPayload<{ include: typeof include }>;
  let citations: NavigatorCitation[];
  if (stage.aiRankingEnabled && query.status === "UNDECIDED") {
    const slim = await prisma.citation.findMany({
      where: filteredWhere,
      select: { id: true, createdAt: true },
    });
    const scores = await prisma.screeningSuggestion.findMany({
      where: { stageId: stage.id, citationId: { in: slim.map((citation) => citation.id) } },
      select: { citationId: true, score: true },
    });
    const scoreByCitation = new Map(scores.map((score) => [score.citationId, score.score]));
    slim.sort((a, b) => {
      const scoreA = scoreByCitation.get(a.id);
      const scoreB = scoreByCitation.get(b.id);
      if (scoreA !== undefined && scoreB !== undefined && scoreA !== scoreB) {
        return scoreB - scoreA;
      }
      if ((scoreA !== undefined) !== (scoreB !== undefined)) {
        return scoreA !== undefined ? -1 : 1;
      }
      const timeDifference = a.createdAt.getTime() - b.createdAt.getTime();
      if (timeDifference !== 0) return timeDifference;
      return a.id.localeCompare(b.id);
    });
    const pageIds = slim
      .slice((page - 1) * query.limit, page * query.limit)
      .map((citation) => citation.id);
    const loaded = await prisma.citation.findMany({
      where: { id: { in: pageIds } },
      include,
    });
    const byId = new Map(loaded.map((citation) => [citation.id, citation]));
    citations = pageIds
      .map((id) => byId.get(id))
      .filter((citation): citation is NavigatorCitation => citation !== undefined);
  } else {
    citations = await prisma.citation.findMany({
      where: filteredWhere,
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      skip: (page - 1) * query.limit,
      take: query.limit,
      include,
    });
  }

  const citationIds = citations.map((citation) => citation.id);
  const suggestions = stage.aiShowScores
    ? await prisma.screeningSuggestion.findMany({
        where: { stageId: stage.id, citationId: { in: citationIds } },
        select: {
          citationId: true,
          score: true,
          suggestedDecision: true,
          rationale: true,
        },
      })
    : [];
  const suggestionByCitation = new Map(
    suggestions.map((suggestion) => [suggestion.citationId, suggestion]),
  );

  return {
    stage: {
      id: stage.id,
      type: stage.type,
      reviewersPerCitation: stage.reviewersPerCitation,
      blinded: stage.blinded,
    },
    summary: { all, undecided, decided, oneReviewer, included, excluded },
    pagination: {
      page,
      limit: query.limit,
      total,
      totalPages,
    },
    items: citations.map((citation) => {
      const assignment = citation.assignments[0]!;
      const decision = citation.decisions[0] ?? null;
      const result = citation.stageResults[0]?.outcome ?? null;
      const suggestion = suggestionByCitation.get(citation.id);
      return {
        assignmentId: assignment.id,
        assignmentStatus: assignment.status,
        citation: citationCard(citation),
        myDecision: decision,
        finalOutcome: result,
        completedReviews: citation._count.assignments,
        requiredReviews: stage.reviewersPerCitation,
        canDecide: result === null,
        aiSuggestion: suggestion
          ? {
              score: suggestion.score,
              suggestedDecision: suggestion.suggestedDecision,
              rationale: suggestion.rationale,
            }
          : null,
      };
    }),
  };
}

type AdminOverviewState =
  | "UNASSIGNED"
  | "NOT_STARTED"
  | "IN_PROGRESS"
  | "CONFLICT"
  | "INCLUDED"
  | "EXCLUDED";

function overviewStatusWhere(
  stageId: string,
  status: AdminOverviewQuery["status"],
): Prisma.CitationWhereInput | undefined {
  const activeAssignment = { stageId, status: { not: "VOIDED" as const } };
  switch (status) {
    case "UNASSIGNED":
      return { assignments: { none: activeAssignment } };
    case "NOT_STARTED":
      return {
        assignments: { some: activeAssignment },
        decisions: { none: { stageId } },
        stageResults: { none: { stageId } },
      };
    case "IN_PROGRESS":
      return {
        decisions: { some: { stageId } },
        stageResults: { none: { stageId } },
        conflicts: { none: { stageId, status: "OPEN" } },
      };
    case "CONFLICT":
      return { conflicts: { some: { stageId, status: "OPEN" } } };
    case "INCLUDED":
      return { stageResults: { some: { stageId, outcome: "INCLUDE" } } };
    case "EXCLUDED":
      return { stageResults: { some: { stageId, outcome: "EXCLUDE" } } };
    case "ALL":
      return undefined;
  }
}

// Owner/Admin oversight across the complete stage pool. This is deliberately not an
// actionable queue and never returns decision values, notes, labels, or exclusion reasons:
// an admin may also be a blinded reviewer. Only assignment progress, open-conflict state, and
// materialized final stage outcomes are exposed.
export async function getAdminOverview(
  ctx: Ctx,
  projectId: string,
  stageId: string,
  query: AdminOverviewQuery,
) {
  await requirePermission(ctx, projectId, "screening.configure");
  const stage = await getStageOr404(prisma, projectId, stageId);

  let eligibleWhere: Prisma.CitationWhereInput = {
    projectId,
    status: "ACTIVE",
  };
  if (stage.type === "FULL_TEXT") {
    const titleAbstractStage = await prisma.screeningStage.findUnique({
      where: { projectId_type: { projectId, type: "TITLE_ABSTRACT" } },
      select: { id: true },
    });
    if (titleAbstractStage) {
      eligibleWhere.stageResults = {
        some: { stageId: titleAbstractStage.id, outcome: "INCLUDE" },
      };
    } else {
      eligibleWhere.id = { in: [] };
    }
  }
  if (query.q) eligibleWhere.title = { contains: query.q, mode: "insensitive" };
  const keywordWhere = await screeningKeywordCitationWhere(
    prisma,
    projectId,
    query.keywordGroup,
  );
  if (keywordWhere) eligibleWhere = { AND: [eligibleWhere, keywordWhere] };

  const statusWhere = overviewStatusWhere(stage.id, query.status);
  const filteredWhere: Prisma.CitationWhereInput = statusWhere
    ? { AND: [eligibleWhere, statusWhere] }
    : eligibleWhere;

  const statusCount = (status: Exclude<AdminOverviewQuery["status"], "ALL">) =>
    prisma.citation.count({
      where: { AND: [eligibleWhere, overviewStatusWhere(stage.id, status)!] },
    });

  const [
    total,
    totalEligible,
    unassigned,
    notStarted,
    inProgress,
    conflicts,
    included,
    excluded,
  ] = await Promise.all([
    prisma.citation.count({ where: filteredWhere }),
    prisma.citation.count({ where: eligibleWhere }),
    statusCount("UNASSIGNED"),
    statusCount("NOT_STARTED"),
    statusCount("IN_PROGRESS"),
    statusCount("CONFLICT"),
    statusCount("INCLUDED"),
    statusCount("EXCLUDED"),
  ]);

  const totalPages = Math.max(1, Math.ceil(total / query.limit));
  const page = Math.min(query.page, totalPages);
  const citations = await prisma.citation.findMany({
    where: filteredWhere,
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    skip: (page - 1) * query.limit,
    take: query.limit,
    select: {
      id: true,
      title: true,
      authors: true,
      year: true,
      journal: true,
      abstract: true,
      doi: true,
      pmid: true,
      createdAt: true,
      sourceRecords: {
        select: { batch: { select: { source: { select: { name: true } } } } },
      },
      assignments: {
        where: { stageId: stage.id, status: { not: "VOIDED" } },
        orderBy: { createdAt: "asc" },
        select: {
          status: true,
          reviewer: { select: { id: true, name: true, email: true } },
        },
      },
      stageResults: {
        where: { stageId: stage.id },
        select: { outcome: true },
        take: 1,
      },
      conflicts: {
        where: { stageId: stage.id, status: "OPEN" },
        select: { id: true },
        take: 1,
      },
    },
  });

  return {
    stage: {
      id: stage.id,
      type: stage.type,
      blinded: stage.blinded,
      reviewersPerCitation: stage.reviewersPerCitation,
    },
    summary: {
      totalEligible,
      unassigned,
      notStarted,
      inProgress,
      conflicts,
      included,
      excluded,
    },
    pagination: {
      page,
      limit: query.limit,
      total,
      totalPages,
    },
    items: citations.map((citation) => {
      const result = citation.stageResults[0]?.outcome;
      const completedReviews = citation.assignments.filter(
        (assignment) => assignment.status === "COMPLETED",
      ).length;
      let state: AdminOverviewState;
      if (result === "INCLUDE") state = "INCLUDED";
      else if (result === "EXCLUDE") state = "EXCLUDED";
      else if (citation.conflicts.length > 0) state = "CONFLICT";
      else if (citation.assignments.length === 0) state = "UNASSIGNED";
      else if (completedReviews === 0) state = "NOT_STARTED";
      else state = "IN_PROGRESS";

      return {
        citation: {
          id: citation.id,
          title: citation.title,
          authors: citation.authors,
          year: citation.year,
          journal: citation.journal,
          abstract: citation.abstract,
          doi: citation.doi,
          pmid: citation.pmid,
          sources: [
            ...new Set(citation.sourceRecords.map((row) => row.batch.source.name)),
          ],
          createdAt: citation.createdAt,
        },
        state,
        assignmentProgress: {
          assigned: citation.assignments.length,
          completed: completedReviews,
          required: stage.reviewersPerCitation,
        },
        reviewers: citation.assignments.map((assignment) => ({
          ...assignment.reviewer,
          status: assignment.status,
        })),
      };
    }),
  };
}

// ---------------------------------------------------------------------------
// 3. Decisions (+ 4. transactional evaluation)
// ---------------------------------------------------------------------------

export async function createDecision(
  ctx: Ctx,
  projectId: string,
  stageId: string,
  input: z.infer<typeof createDecisionSchema>,
) {
  await requirePermission(ctx, projectId, "screening.decide");
  return prisma.$transaction(async (tx) => {
    const stage = await getStageOr404(tx, projectId, stageId);
    await assertIndividualTitleAbstractAllowed(tx, stage);
    return createDecisionInTransaction(tx, ctx, projectId, stage, input);
  });
}

// Apply one exclusion reason to several of the current reviewer's assigned citations.
// The entire batch is atomic: if any citation is no longer actionable, every write rolls
// back so a stale selection can never be partially applied.
export async function batchExclude(
  ctx: Ctx,
  projectId: string,
  stageId: string,
  input: z.infer<typeof batchExcludeSchema>,
) {
  await requirePermission(ctx, projectId, "screening.decide");
  return prisma.$transaction(async (tx) => {
    const stage = await getStageOr404(tx, projectId, stageId);
    await assertIndividualTitleAbstractAllowed(tx, stage);

    // Validate the common reason before any decision writes. The per-citation helper also
    // validates it, preserving the same lifecycle contract as an individual exclusion.
    await validateExclusionReason(
      tx,
      projectId,
      stage.type,
      input.exclusionReasonId,
    );

    const actionableCount = await tx.citation.count({
      where: {
        id: { in: input.citationIds },
        projectId,
        status: "ACTIVE",
        assignments: {
          some: {
            stageId: stage.id,
            reviewerId: ctx.userId,
            status: { not: "VOIDED" },
          },
        },
        decisions: {
          none: { stageId: stage.id, reviewerId: ctx.userId },
        },
        stageResults: { none: { stageId: stage.id } },
      },
    });
    if (actionableCount !== input.citationIds.length) {
      throw invalidState(
        "One or more selected citations are no longer undecided and assigned to you. Refresh the article list and try again.",
      );
    }

    for (const citationId of input.citationIds) {
      await createDecisionInTransaction(
        tx,
        ctx,
        projectId,
        stage,
        {
          citationId,
          decision: "EXCLUDE",
          exclusionReasonId: input.exclusionReasonId,
          notes: null,
          labels: [],
          flaggedForDiscussion: false,
        },
        { batchExclusion: true, batchSize: input.citationIds.length },
      );
    }

    return { excluded: input.citationIds.length };
  }, { timeout: 30_000 });
}

// Shared decision write used by both the ordinary per-PICO queue and the guideline-level
// pooled title/abstract queue. Callers must perform their own permission checks before
// opening the transaction. Keeping the mutation here preserves the exact R3/R5/R6/R7
// lifecycle, assignment gate, blinding-safe audit rows, and result materialization for both
// entry points.
export async function createDecisionInTransaction(
  tx: Tx,
  ctx: Ctx,
  projectId: string,
  stage: ScreeningStage,
  input: z.infer<typeof createDecisionSchema>,
  auditMetadata?: Record<string, unknown>,
) {
  if (stage.projectId !== projectId) throw notFound("Screening stage");

  // R9: tenant-scoped citation load; must be ACTIVE to screen.
  const citation = await tx.citation.findFirst({
    where: { id: input.citationId, projectId },
  });
  if (!citation) throw notFound("Citation");
  if (citation.status !== "ACTIVE") {
    throw invalidState("Citation is a merged duplicate and cannot be screened");
  }

  // The reviewer is ALWAYS the session user and must hold a live assignment.
  const assignment = await tx.screeningAssignment.findUnique({
    where: {
      stageId_citationId_reviewerId: {
        stageId: stage.id,
        citationId: citation.id,
        reviewerId: ctx.userId,
      },
    },
  });
  if (!assignment || assignment.status === "VOIDED") {
    throw forbidden("You are not assigned to screen this citation at this stage");
  }

  // R5 lock: once a stage result exists, decisions are immutable until reopen.
  const existingResult = await tx.citationStageResult.findUnique({
    where: { stageId_citationId: { stageId: stage.id, citationId: citation.id } },
  });
  if (existingResult) {
    throw invalidState(
      "This citation is already settled at this stage — an admin/adjudicator must reopen it first",
    );
  }

  // Exclusion reason rules: FULL_TEXT + EXCLUDE requires a reason (R14/protocol);
  // TITLE_ABSTRACT + EXCLUDE may optionally carry one. Reasons on non-EXCLUDE are dropped.
  let exclusionReasonId: string | null = null;
  if (input.decision === "EXCLUDE") {
    if (stage.type === "FULL_TEXT" && !input.exclusionReasonId) {
      throw validationError("Full-text exclusions require an exclusion reason");
    }
    if (input.exclusionReasonId) {
      const reason = await validateExclusionReason(
        tx,
        projectId,
        stage.type,
        input.exclusionReasonId,
      );
      exclusionReasonId = reason.id;
    }
  }

  const previous = await tx.screeningDecision.findUnique({
    where: {
      stageId_citationId_reviewerId: {
        stageId: stage.id,
        citationId: citation.id,
        reviewerId: ctx.userId,
      },
    },
  });
  const data = {
    decision: input.decision,
    exclusionReasonId,
    // An omitted note means "leave my note alone" on a revision. Sending null or an
    // empty string remains an explicit clear, while a new decision still defaults to null.
    notes: input.notes === undefined ? (previous?.notes ?? null) : input.notes,
    labels: input.labels ?? [],
    flaggedForDiscussion: input.flaggedForDiscussion ?? false,
  };
  const decision = previous
    ? await tx.screeningDecision.update({ where: { id: previous.id }, data })
    : await tx.screeningDecision.create({
        data: {
          stageId: stage.id,
          citationId: citation.id,
          reviewerId: ctx.userId,
          ...data,
        },
      });

  if (assignment.status !== "COMPLETED") {
    await tx.screeningAssignment.update({
      where: { id: assignment.id },
      data: { status: "COMPLETED" },
    });
  }

  await audit.record(tx, {
    projectId,
    userId: ctx.userId,
    entityType: "ScreeningDecision",
    entityId: decision.id,
    action: previous
      ? AuditActions.SCREENING_DECISION_UPDATED
      : AuditActions.SCREENING_DECISION_CREATED,
    previousValue: previous
      ? {
          decision: previous.decision,
          exclusionReasonId: previous.exclusionReasonId,
          notes: previous.notes,
          labels: previous.labels,
        }
      : undefined,
    newValue: {
      decision: decision.decision,
      exclusionReasonId: decision.exclusionReasonId,
      notes: decision.notes,
      labels: decision.labels,
    },
    metadata: auditMetadata,
  });

  // R6: conflict/consensus evaluation runs in the SAME transaction as the decision write.
  const evaluation = await evaluateCitation(tx, ctx, stage, citation.id);
  return {
    decision,
    // Only the materialized result is echoed back — once it exists it is visible to
    // everyone anyway (blinding lifts). Conflict state is NOT returned to reviewers.
    result: evaluation.result
      ? { outcome: evaluation.result.outcome, resolvedVia: evaluation.result.resolvedVia }
      : null,
  };
}

// R6/R7 — the conflict/consensus state machine for one (stage, citation).
// ALWAYS called inside the caller's transaction.
export async function evaluateCitation(
  tx: Tx,
  ctx: Ctx,
  stage: ScreeningStage,
  citationId: string,
) {
  // Only decisions by reviewers holding a non-VOIDED assignment count (R8: merged-duplicate
  // assignments are VOIDED and their reviewers' decisions stop counting).
  const activeAssignments = await tx.screeningAssignment.findMany({
    where: { stageId: stage.id, citationId, status: { not: "VOIDED" } },
    select: { reviewerId: true },
  });
  const activeReviewers = new Set(activeAssignments.map((a) => a.reviewerId));
  const allDecisions = await tx.screeningDecision.findMany({
    where: { stageId: stage.id, citationId },
  });
  const decisions = allDecisions.filter((d) => activeReviewers.has(d.reviewerId));

  const required = stage.reviewersPerCitation;
  // Not enough decisions yet → nothing to evaluate; any OPEN conflict stays open.
  if (decisions.length < required) return { status: "pending" as const, result: null };

  const values = new Set(decisions.map((d) => d.decision));
  const unanimous = values.size === 1 ? decisions[0]!.decision : null;
  const existingConflict = await tx.screeningConflict.findUnique({
    where: { stageId_citationId: { stageId: stage.id, citationId } },
  });

  if (unanimous === "INCLUDE" || unanimous === "EXCLUDE") {
    // Consensus → materialize the stage result (R3).
    const result = await tx.citationStageResult.create({
      data: {
        stageId: stage.id,
        citationId,
        outcome: unanimous,
        resolvedVia: required === 1 ? "SINGLE_REVIEWER" : "CONSENSUS",
      },
    });
    await audit.record(tx, {
      projectId: stage.projectId,
      userId: ctx.userId,
      entityType: "CitationStageResult",
      entityId: result.id,
      action: AuditActions.SCREENING_RESULT_CREATED,
      newValue: {
        stageId: stage.id,
        citationId,
        outcome: result.outcome,
        resolvedVia: result.resolvedVia,
      },
    });
    // Agreement after an edit auto-resolves a previously OPEN conflict (R6).
    if (existingConflict && existingConflict.status === "OPEN") {
      await tx.screeningConflict.update({
        where: { id: existingConflict.id },
        data: { status: "VOIDED", resolvedAt: new Date() },
      });
    }
    // FT INCLUDE → auto-create the Study with its primary report link (R14).
    if (unanimous === "INCLUDE" && stage.type === "FULL_TEXT") {
      await studies.autoCreateForCitation(tx, ctx, stage.projectId, citationId);
    }
    return { status: "settled" as const, result };
  }

  // Disagreement paths (R7):
  //  - unanimous MAYBE ALWAYS opens a conflict (someone must decide), flag or not;
  //  - INCLUDE-vs-EXCLUDE split always opens a conflict;
  //  - mixed involving MAYBE (e.g. INCLUDE+MAYBE) opens one only when
  //    stage.maybeGeneratesConflict is true.
  const needsConflict =
    unanimous === "MAYBE" ||
    (values.has("INCLUDE") && values.has("EXCLUDE")) ||
    (values.has("MAYBE") && stage.maybeGeneratesConflict);

  if (needsConflict) {
    // Only one conflict row per (stage, citation) — reuse a VOIDED one by reopening it.
    if (!existingConflict) {
      const opened = await tx.screeningConflict.create({
        data: { stageId: stage.id, citationId },
      });
      await audit.record(tx, {
        projectId: stage.projectId,
        userId: ctx.userId,
        entityType: "ScreeningConflict",
        entityId: opened.id,
        action: AuditActions.SCREENING_CONFLICT_OPENED,
        newValue: { stageId: stage.id, citationId },
      });
    } else if (existingConflict.status !== "OPEN") {
      await tx.screeningConflict.update({
        where: { id: existingConflict.id },
        data: { status: "OPEN", openedAt: new Date(), resolvedAt: null },
      });
      await audit.record(tx, {
        projectId: stage.projectId,
        userId: ctx.userId,
        entityType: "ScreeningConflict",
        entityId: existingConflict.id,
        action: AuditActions.SCREENING_CONFLICT_REOPENED,
        previousValue: { status: existingConflict.status },
        newValue: { status: "OPEN" },
      });
    }
    return { status: "conflict" as const, result: null };
  }

  // Mixed involving MAYBE with maybeGeneratesConflict=false: intentionally left unsettled —
  // no conflict is opened and no result materializes. The MAYBE reviewer(s) must revise
  // their decision to a decisive one before consensus or a conflict can emerge. A
  // previously OPEN conflict (from an earlier decisive split) is left open for the
  // adjudicator rather than silently discarded.
  return { status: "unsettled" as const, result: null };
}

// ---------------------------------------------------------------------------
// 5. Blinding — who may see whose decisions
// ---------------------------------------------------------------------------

export async function listDecisions(
  ctx: Ctx,
  projectId: string,
  stageId: string,
  citationId: string,
) {
  const member = await requirePermission(ctx, projectId, "project.view");
  const stage = await getStageOr404(prisma, projectId, stageId);
  const citation = await prisma.citation.findFirst({
    where: { id: citationId, projectId },
    select: { id: true },
  });
  if (!citation) throw notFound("Citation");
  return visibleDecisionsFor(ctx, member, stage, citation.id);
}

// THE blinding rule (docs/02 + task R-blinding): adjudicators and project editors see all
// decisions; everyone else always sees their own, and others' ONLY once the stage is
// unblinded (blinded=false) or the citation is settled (a CitationStageResult exists).
export async function visibleDecisionsFor(
  ctx: Ctx,
  member: ProjectMember,
  stage: ScreeningStage,
  citationId: string,
) {
  const decisions = await prisma.screeningDecision.findMany({
    where: { stageId: stage.id, citationId },
    include: decisionInclude,
    orderBy: { createdAt: "asc" },
  });
  const seesAll =
    can(member.roles, "screening.adjudicate") || can(member.roles, "project.edit");
  if (seesAll || stage.blinded === false) return decisions;
  const result = await prisma.citationStageResult.findUnique({
    where: { stageId_citationId: { stageId: stage.id, citationId } },
  });
  if (result) return decisions;
  return decisions.filter((d) => d.reviewerId === ctx.userId);
}

// ---------------------------------------------------------------------------
// 6. Conflicts & adjudication
// ---------------------------------------------------------------------------

export async function listConflicts(
  ctx: Ctx,
  projectId: string,
  query: z.infer<typeof listConflictsQuerySchema>,
) {
  await requirePermission(ctx, projectId, "screening.adjudicate");
  const conflicts = await prisma.screeningConflict.findMany({
    where: {
      stage: { projectId, ...(query.stage ? { type: query.stage } : {}) },
      ...(query.status ? { status: query.status } : {}),
      citation: { status: "ACTIVE" }, // R8: merged duplicates drop out of every queue
    },
    include: {
      stage: { select: { id: true, type: true } },
      citation: { include: citationCardInclude },
      adjudication: {
        include: {
          adjudicator: { select: { id: true, name: true } },
          exclusionReason: { select: { id: true, label: true } },
        },
      },
    },
    orderBy: [{ openedAt: "asc" }, { id: "asc" }],
  });

  const decisions =
    conflicts.length === 0
      ? []
      : await prisma.screeningDecision.findMany({
          where: {
            OR: conflicts.map((c) => ({ stageId: c.stageId, citationId: c.citationId })),
          },
          include: decisionInclude,
          orderBy: { createdAt: "asc" },
        });
  const decisionKey = (stageId: string, citationId: string) => `${stageId}:${citationId}`;
  const decisionsByPair = new Map<string, typeof decisions>();
  for (const d of decisions) {
    const key = decisionKey(d.stageId, d.citationId);
    const list = decisionsByPair.get(key) ?? [];
    list.push(d);
    decisionsByPair.set(key, list);
  }

  // Eligibility criteria give the adjudicator protocol context alongside the votes.
  const criteria = await prisma.eligibilityCriterion.findMany({
    where: { protocol: { projectId } },
    orderBy: [{ type: "asc" }, { order: "asc" }],
    select: { id: true, type: true, category: true, text: true, order: true },
  });

  return {
    conflicts: conflicts.map((c) => ({
      id: c.id,
      status: c.status,
      openedAt: c.openedAt,
      resolvedAt: c.resolvedAt,
      stage: c.stage,
      citation: citationCard(c.citation),
      decisions: decisionsByPair.get(decisionKey(c.stageId, c.citationId)) ?? [],
      adjudication: c.adjudication,
    })),
    criteria,
  };
}

export async function adjudicateConflict(
  ctx: Ctx,
  projectId: string,
  conflictId: string,
  input: z.infer<typeof adjudicateSchema>,
) {
  await requirePermission(ctx, projectId, "screening.adjudicate");
  return prisma.$transaction(async (tx) => {
    // R9: tenant scoping via the stage's project.
    const conflictRow = await tx.screeningConflict.findFirst({
      where: { id: conflictId, stage: { projectId } },
      include: { stage: true, adjudication: true, citation: { select: { status: true } } },
    });
    if (!conflictRow) throw notFound("Conflict");
    if (conflictRow.status !== "OPEN") throw invalidState("Conflict is not open");
    if (conflictRow.citation.status !== "ACTIVE") {
      throw invalidState("Citation is a merged duplicate and cannot be adjudicated");
    }

    let exclusionReasonId: string | null = null;
    if (input.finalDecision === "EXCLUDE") {
      if (conflictRow.stage.type === "FULL_TEXT" && !input.exclusionReasonId) {
        throw validationError("Full-text exclusions require an exclusion reason");
      }
      if (input.exclusionReasonId) {
        const reason = await validateExclusionReason(
          tx,
          projectId,
          conflictRow.stage.type,
          input.exclusionReasonId,
        );
        exclusionReasonId = reason.id;
      }
    }

    // 1:1 with the conflict — re-adjudication after a reopen updates the row in place (R6).
    const previous = conflictRow.adjudication;
    const adjudication = previous
      ? await tx.screeningAdjudication.update({
          where: { id: previous.id },
          data: {
            adjudicatorId: ctx.userId,
            finalDecision: input.finalDecision,
            exclusionReasonId,
            reason: input.reason,
          },
        })
      : await tx.screeningAdjudication.create({
          data: {
            conflictId: conflictRow.id,
            adjudicatorId: ctx.userId,
            finalDecision: input.finalDecision,
            exclusionReasonId,
            reason: input.reason,
          },
        });

    const resolved = await tx.screeningConflict.update({
      where: { id: conflictRow.id },
      data: { status: "RESOLVED", resolvedAt: new Date() },
    });

    // Adjudicated outcome materializes the stage result (R3). Reviewer decisions are
    // NEVER modified by adjudication.
    const result = await tx.citationStageResult.upsert({
      where: {
        stageId_citationId: {
          stageId: conflictRow.stageId,
          citationId: conflictRow.citationId,
        },
      },
      create: {
        stageId: conflictRow.stageId,
        citationId: conflictRow.citationId,
        outcome: input.finalDecision,
        resolvedVia: "ADJUDICATION",
      },
      update: {
        outcome: input.finalDecision,
        resolvedVia: "ADJUDICATION",
        resolvedAt: new Date(),
      },
    });

    await audit.record(tx, {
      projectId,
      userId: ctx.userId,
      entityType: "ScreeningAdjudication",
      entityId: adjudication.id,
      action: AuditActions.SCREENING_CONFLICT_ADJUDICATED,
      previousValue: previous
        ? {
            finalDecision: previous.finalDecision,
            exclusionReasonId: previous.exclusionReasonId,
            reason: previous.reason,
            adjudicatorId: previous.adjudicatorId,
          }
        : undefined,
      newValue: {
        conflictId: conflictRow.id,
        finalDecision: adjudication.finalDecision,
        exclusionReasonId: adjudication.exclusionReasonId,
      },
      reason: input.reason,
    });
    await audit.record(tx, {
      projectId,
      userId: ctx.userId,
      entityType: "CitationStageResult",
      entityId: result.id,
      action: AuditActions.SCREENING_RESULT_CREATED,
      newValue: {
        stageId: conflictRow.stageId,
        citationId: conflictRow.citationId,
        outcome: result.outcome,
        resolvedVia: result.resolvedVia,
      },
    });

    if (input.finalDecision === "INCLUDE" && conflictRow.stage.type === "FULL_TEXT") {
      await studies.autoCreateForCitation(tx, ctx, projectId, conflictRow.citationId);
    }

    return { adjudication, conflict: resolved, result };
  });
}

// ---------------------------------------------------------------------------
// 8. Reopen (R5)
// ---------------------------------------------------------------------------

export async function reopenCitation(
  ctx: Ctx,
  projectId: string,
  citationId: string,
  input: z.infer<typeof reopenSchema>,
) {
  // screening.adjudicate OR project.edit may reopen.
  const member = await getMembership(ctx.userId, projectId);
  if (
    !member ||
    !(can(member.roles, "screening.adjudicate") || can(member.roles, "project.edit"))
  ) {
    throw forbidden();
  }
  return prisma.$transaction(async (tx) => {
    const citation = await tx.citation.findFirst({ where: { id: citationId, projectId } });
    if (!citation) throw notFound("Citation");
    const stage = await tx.screeningStage.findUnique({
      where: { projectId_type: { projectId, type: input.stageType } },
    });
    if (!stage) throw notFound("Screening stage");
    const result = await tx.citationStageResult.findUnique({
      where: { stageId_citationId: { stageId: stage.id, citationId: citation.id } },
    });
    if (!result) throw invalidState("No stage result exists to reopen at this stage");

    await tx.citationStageResult.delete({ where: { id: result.id } });
    await audit.record(tx, {
      projectId,
      userId: ctx.userId,
      entityType: "CitationStageResult",
      entityId: result.id,
      action: AuditActions.SCREENING_RESULT_REOPENED,
      previousValue: {
        stageId: stage.id,
        citationId: citation.id,
        outcome: result.outcome,
        resolvedVia: result.resolvedVia,
        resolvedAt: result.resolvedAt,
      },
      reason: input.reason,
    });

    // A RESOLVED conflict for this (stage, citation) is voided; if disagreement recurs,
    // evaluateCitation flips it back to OPEN and re-adjudication updates the 1:1 row.
    const conflictRow = await tx.screeningConflict.findUnique({
      where: { stageId_citationId: { stageId: stage.id, citationId: citation.id } },
    });
    if (conflictRow && conflictRow.status === "RESOLVED") {
      await tx.screeningConflict.update({
        where: { id: conflictRow.id },
        data: { status: "VOIDED" },
      });
    }

    return { reopened: true, stageId: stage.id, citationId: citation.id };
  });
}
