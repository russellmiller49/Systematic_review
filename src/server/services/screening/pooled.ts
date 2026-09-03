// Guideline-level pooled title/abstract screening.
//
// A guideline stores each PICO as an independent review project. This service presents the
// selected PICO projects as one blind-safe reviewer queue, groups exact cross-PICO citation
// matches, assigns the same reviewers to every copy in a group, and writes one human choice to
// every linked PICO record atomically. The underlying per-project ScreeningDecision,
// ScreeningAssignment, conflict, and CitationStageResult rows remain the source of truth.

import { z } from "zod";
import type { Prisma, ScreeningStage } from "@prisma/client";
import { prisma } from "@/server/db";
import { invalidState, notFound, validationError } from "@/server/errors";
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
  .refine((ids) => new Set(ids).size === ids.length, "PICO projects must be unique");

export const pooledSelectionSchema = z.object({
  projectIds: projectIdsSchema,
});

export const createPooledAssignmentsSchema = z.object({
  projectIds: projectIdsSchema,
  reviewerIds: z.array(z.string().trim().min(1)).min(1).max(50),
  strategy: z.enum(["all", "split"]),
});

export const createPooledDecisionSchema = z.object({
  projectIds: projectIdsSchema,
  citationIds: z
    .array(z.string().trim().min(1))
    .min(1)
    .max(200)
    .refine((ids) => new Set(ids).size === ids.length, "Citations must be unique"),
  decision: z.enum(["INCLUDE", "EXCLUDE"]),
  exclusionReasonLabel: z.string().trim().min(1).max(300).nullable().optional(),
  notes: z.string().max(20_000).nullable().optional(),
});

type PooledIdentityRow = {
  id: string;
  projectId: string;
  doi: string | null;
  pmid: string | null;
  normalizedTitle: string;
  createdAt: Date;
};

// Exact DOI, PMID, or normalized-title matches form one connected component. The connected
// component matters: one import may have the DOI but another may only carry the matching title.
// This mirrors the app's exact deduplication signals without applying fuzzy matching across
// tenant-separated PICO projects.
export function groupPooledCitationRows<T extends PooledIdentityRow>(rows: readonly T[]): T[][] {
  const parent = rows.map((_, index) => index);
  const rank = rows.map(() => 0);

  const find = (index: number): number => {
    let root = index;
    while (parent[root] !== root) root = parent[root]!;
    while (parent[index] !== index) {
      const next = parent[index]!;
      parent[index] = root;
      index = next;
    }
    return root;
  };
  const union = (a: number, b: number) => {
    let rootA = find(a);
    let rootB = find(b);
    if (rootA === rootB) return;
    if (rank[rootA]! < rank[rootB]!) [rootA, rootB] = [rootB, rootA];
    parent[rootB] = rootA;
    if (rank[rootA] === rank[rootB]) rank[rootA]! += 1;
  };

  const firstByIdentity = new Map<string, number>();
  rows.forEach((row, index) => {
    const identities = [
      row.doi?.trim().toLowerCase() ? `doi:${row.doi.trim().toLowerCase()}` : null,
      row.pmid?.trim() ? `pmid:${row.pmid.trim()}` : null,
      row.normalizedTitle.trim()
        ? `title:${row.normalizedTitle.trim().toLowerCase()}`
        : null,
    ].filter((identity): identity is string => identity !== null);
    for (const identity of identities) {
      const first = firstByIdentity.get(identity);
      if (first === undefined) firstByIdentity.set(identity, index);
      else union(first, index);
    }
  });

  const grouped = new Map<number, T[]>();
  rows.forEach((row, index) => {
    const root = find(index);
    const group = grouped.get(root) ?? [];
    group.push(row);
    grouped.set(root, group);
  });
  return [...grouped.values()].sort((a, b) => {
    const aTime = Math.min(...a.map((row) => row.createdAt.getTime()));
    const bTime = Math.min(...b.map((row) => row.createdAt.getTime()));
    if (aTime !== bTime) return aTime - bTime;
    return a[0]!.id.localeCompare(b[0]!.id);
  });
}

async function loadGuidelineSelection(
  ctx: Ctx,
  guidelineId: string,
  projectIds: string[],
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

  const requested = new Set(projectIds);
  const selected = guideline.subProjects
    .map((project, index) => ({ ...project, picoNumber: index + 1 }))
    .filter((project) => requested.has(project.id));
  if (selected.length !== requested.size) {
    throw validationError("Every selected project must be a PICO in this guideline");
  }
  for (const project of selected) {
    await requirePermission(ctx, project.id, capability);
  }
  return { guideline: { id: guideline.id, title: guideline.title }, selected };
}

async function titleAbstractStages(projectIds: string[]): Promise<ScreeningStage[]> {
  await Promise.all(projectIds.map((projectId) => ensureStages(projectId)));
  const stages = await prisma.screeningStage.findMany({
    where: { projectId: { in: projectIds }, type: "TITLE_ABSTRACT" },
  });
  if (stages.length !== projectIds.length) throw notFound("Title and abstract screening stage");
  const reviewerCounts = new Set(stages.map((stage) => stage.reviewersPerCitation));
  if (reviewerCounts.size !== 1) {
    throw invalidState(
      "Selected PICOs must use the same number of title/abstract reviewers before they can share a pooled queue",
    );
  }
  return stages;
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

type PooledCitation = Prisma.CitationGetPayload<{ select: typeof pooledCitationSelect }>;

function bestRepresentative(group: PooledCitation[]): PooledCitation {
  return [...group].sort((a, b) => {
    const abstractDifference = (b.abstract?.trim().length ?? 0) - (a.abstract?.trim().length ?? 0);
    if (abstractDifference !== 0) return abstractDifference;
    const identifierDifference = Number(Boolean(b.doi || b.pmid)) - Number(Boolean(a.doi || a.pmid));
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
  input: z.infer<typeof pooledSelectionSchema>,
) {
  const family = await loadGuidelineSelection(
    ctx,
    guidelineId,
    input.projectIds,
    "screening.decide",
  );
  const orderedProjectIds = family.selected.map((project) => project.id);
  const stages = await titleAbstractStages(orderedProjectIds);
  const stageByProject = new Map(stages.map((stage) => [stage.projectId, stage]));

  const citations = await prisma.citation.findMany({
    where: { projectId: { in: orderedProjectIds }, status: "ACTIVE" },
    select: pooledCitationSelect,
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
  });
  const groups = groupPooledCitationRows(citations);
  const citationIds = citations.map((citation) => citation.id);
  const stageIds = stages.map((stage) => stage.id);
  const [assignments, decisions, results, reasons] = await Promise.all([
    prisma.screeningAssignment.findMany({
      where: {
        stageId: { in: stageIds },
        citationId: { in: citationIds },
        reviewerId: ctx.userId,
        status: { not: "VOIDED" },
      },
      select: { stageId: true, citationId: true, status: true },
    }),
    prisma.screeningDecision.findMany({
      where: {
        stageId: { in: stageIds },
        citationId: { in: citationIds },
        reviewerId: ctx.userId,
      },
      select: { stageId: true, citationId: true },
    }),
    prisma.citationStageResult.findMany({
      where: { stageId: { in: stageIds }, citationId: { in: citationIds } },
      select: { stageId: true, citationId: true, outcome: true },
    }),
    prisma.exclusionReason.findMany({
      where: {
        projectId: { in: orderedProjectIds },
        isActive: true,
        stage: { in: ["TITLE_ABSTRACT", "BOTH"] },
      },
      select: { projectId: true, label: true, order: true },
      orderBy: [{ order: "asc" }, { label: "asc" }],
    }),
  ]);

  const pairKey = (stageId: string, citationId: string) => `${stageId}:${citationId}`;
  const assignmentByPair = new Map(
    assignments.map((assignment) => [
      pairKey(assignment.stageId, assignment.citationId),
      assignment,
    ]),
  );
  const decisionPairs = new Set(
    decisions.map((decision) => pairKey(decision.stageId, decision.citationId)),
  );
  const resultByPair = new Map(
    results.map((result) => [pairKey(result.stageId, result.citationId), result]),
  );

  const reasonsByLabel = new Map<string, Set<string>>();
  const reasonOrder = new Map<string, number>();
  for (const reason of reasons) {
    const projects = reasonsByLabel.get(reason.label) ?? new Set<string>();
    projects.add(reason.projectId);
    reasonsByLabel.set(reason.label, projects);
    reasonOrder.set(reason.label, Math.min(reasonOrder.get(reason.label) ?? reason.order, reason.order));
  }
  const commonReasons = [...reasonsByLabel.entries()]
    .filter(([, projects]) => orderedProjectIds.every((projectId) => projects.has(projectId)))
    .map(([label]) => ({ label }))
    .sort((a, b) => {
      const orderDifference = (reasonOrder.get(a.label) ?? 0) - (reasonOrder.get(b.label) ?? 0);
      return orderDifference !== 0 ? orderDifference : a.label.localeCompare(b.label);
    });

  let ready = 0;
  let awaitingOtherReviewers = 0;
  let needsAssignment = 0;
  let settledOrOutOfSync = 0;
  const readyGroups: PooledCitation[][] = [];
  for (const group of groups) {
    const pairs = group.map((citation) => {
      const stage = stageByProject.get(citation.projectId)!;
      const key = pairKey(stage.id, citation.id);
      return {
        assignment: assignmentByPair.get(key),
        hasDecision: decisionPairs.has(key),
        result: resultByPair.get(key),
      };
    });
    const resultCount = pairs.filter((pair) => pair.result).length;
    const decisionCount = pairs.filter((pair) => pair.hasDecision).length;
    if (resultCount > 0 || (decisionCount > 0 && decisionCount < pairs.length)) {
      settledOrOutOfSync += 1;
    } else if (decisionCount === pairs.length) {
      awaitingOtherReviewers += 1;
    } else if (
      pairs.every(
        (pair) => pair.assignment !== undefined && pair.assignment.status === "PENDING",
      )
    ) {
      ready += 1;
      readyGroups.push(group);
    } else {
      needsAssignment += 1;
    }
  }

  const projectById = new Map(family.selected.map((project) => [project.id, project]));
  return {
    guideline: family.guideline,
    picos: family.selected,
    configuration: {
      reviewersPerCitation: stages[0]!.reviewersPerCitation,
      blinded: stages.every((stage) => stage.blinded),
    },
    summary: {
      pooledAbstracts: groups.length,
      linkedCitationRecords: citations.length,
      overlaps: groups.filter(
        (group) => new Set(group.map((citation) => citation.projectId)).size > 1,
      ).length,
      ready,
      awaitingOtherReviewers,
      needsAssignment,
      settledOrOutOfSync,
    },
    total: ready,
    reasons: commonReasons,
    items: readyGroups.slice(0, 25).map((group) => {
      const representative = bestRepresentative(group);
      const byProject = new Map<string, string[]>();
      for (const citation of group) {
        const ids = byProject.get(citation.projectId) ?? [];
        ids.push(citation.id);
        byProject.set(citation.projectId, ids);
      }
      return {
        citationIds: group.map((citation) => citation.id).sort(),
        citation: queueCitation(representative),
        picos: [...byProject.entries()]
          .map(([projectId, ids]) => ({
            ...projectById.get(projectId)!,
            citationIds: ids.sort(),
          }))
          .sort((a, b) => a.picoNumber - b.picoNumber),
      };
    }),
  };
}

export async function createPooledAssignments(
  ctx: Ctx,
  guidelineId: string,
  input: z.infer<typeof createPooledAssignmentsSchema>,
) {
  const family = await loadGuidelineSelection(
    ctx,
    guidelineId,
    input.projectIds,
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
      orderedProjectIds.some((projectId) => !eligible.has(`${projectId}:${reviewerId}`)),
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
    const stageByProject = new Map(stages.map((stage) => [stage.projectId, stage]));
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
              (_, offset) => reviewerIds[(cursor + offset) % reviewerIds.length]!,
            );
      if (input.strategy === "split") {
        cursor = (cursor + reviewersPerCitation) % reviewerIds.length;
      }
      for (const citation of group) {
        const stage = stageByProject.get(citation.projectId)!;
        const projectPairs = pairsByProject.get(citation.projectId) ?? [];
        for (const reviewerId of assignedReviewers) {
          projectPairs.push({ stageId: stage.id, citationId: citation.id, reviewerId });
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
  const family = await loadGuidelineSelection(
    ctx,
    guidelineId,
    input.projectIds,
    "screening.decide",
  );
  const orderedProjectIds = family.selected.map((project) => project.id);
  const stages = await titleAbstractStages(orderedProjectIds);

  return prisma.$transaction(async (tx) => {
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
    });
    const groups = groupPooledCitationRows(citations);
    const requestedIds = new Set(input.citationIds);
    const group = groups.find((candidate) =>
      candidate.some((citation) => requestedIds.has(citation.id)),
    );
    if (
      !group ||
      group.length !== requestedIds.size ||
      group.some((citation) => !requestedIds.has(citation.id))
    ) {
      throw invalidState(
        "This pooled abstract changed after it was loaded. Refresh the queue before deciding.",
      );
    }

    const reasonByProject = new Map<string, string>();
    if (input.decision === "EXCLUDE") {
      if (!input.exclusionReasonLabel) {
        throw validationError("Pooled title/abstract exclusions require a common reason subgroup");
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
      for (const reason of reasons) reasonByProject.set(reason.projectId, reason.id);
      if (orderedProjectIds.some((projectId) => !reasonByProject.has(projectId))) {
        throw validationError(
          "The selected exclusion reason must be active in every PICO in this pooled queue",
        );
      }
    }

    const stageByProject = new Map(stages.map((stage) => [stage.projectId, stage]));
    const metadata = {
      pooledGuidelineId: guidelineId,
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
            notes: input.notes ?? null,
            labels: [],
            flaggedForDiscussion: false,
          },
          metadata,
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
