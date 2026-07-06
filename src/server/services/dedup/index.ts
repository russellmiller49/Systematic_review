// Deduplication service — detection run, group review, merge / reject / undo workflow.
// Policies: R8 (merge after screening began), R9 (tenant-scoped loads), R17 (canonical must
// be in the group and in the project). Engine (engine.ts) is pure; all persistence is here.

import { z } from "zod";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/server/db";
import { notFound, invalidState } from "@/server/errors";
import type { Ctx } from "@/server/auth/session";
import { requirePermission } from "@/server/permissions";
import * as audit from "@/server/services/audit";
import { AuditActions } from "@/server/services/audit";
import type { AuthorName } from "@/server/services/citations/normalize";
import { detectDuplicates, type CitationLite } from "./engine";

export const listGroupsQuerySchema = z.object({
  status: z.enum(["OPEN", "RESOLVED"]).optional(),
});

export const mergeGroupSchema = z.object({
  canonicalCitationId: z.string().min(1),
});

type MergeAuditMetadata = {
  groupId?: string;
  voidedAssignmentIds?: string[];
  voidedConflictIds?: string[];
};

// Run (or re-run) duplicate detection over the project's ACTIVE citations. Idempotent:
// pairs already decided (MERGED/REJECTED) are skipped, still-SUGGESTED pairs are refreshed,
// and groups are rebuilt as connected components over SUGGESTED pairs.
export async function runDetection(ctx: Ctx, projectId: string) {
  await requirePermission(ctx, projectId, "dedup.manage");

  const citations = await prisma.citation.findMany({
    where: { projectId, status: "ACTIVE" },
    select: {
      id: true,
      normalizedTitle: true,
      doi: true,
      pmid: true,
      year: true,
      journal: true,
      authors: true,
    },
  });
  const lites: CitationLite[] = citations.map((c) => ({
    id: c.id,
    normalizedTitle: c.normalizedTitle,
    doi: c.doi,
    pmid: c.pmid,
    year: c.year,
    journal: c.journal,
    authors: Array.isArray(c.authors) ? (c.authors as unknown as AuthorName[]) : [],
  }));
  const pairs = detectDuplicates(lites);

  return prisma.$transaction(async (tx) => {
    const existing = await tx.deduplicationCandidate.findMany({ where: { projectId } });
    const byPair = new Map(existing.map((c) => [`${c.citationAId}|${c.citationBId}`, c]));

    let candidatesCreated = 0;
    let candidatesRefreshed = 0;
    let candidatesSkippedDecided = 0;
    for (const pair of pairs) {
      const current = byPair.get(`${pair.aId}|${pair.bId}`);
      if (!current) {
        await tx.deduplicationCandidate.create({
          data: {
            projectId,
            citationAId: pair.aId,
            citationBId: pair.bId,
            method: pair.method,
            score: pair.score,
            reasons: pair.reasons as unknown as Prisma.InputJsonValue,
          },
        });
        candidatesCreated++;
      } else if (current.status === "SUGGESTED") {
        await tx.deduplicationCandidate.update({
          where: { id: current.id },
          data: {
            method: pair.method,
            score: pair.score,
            reasons: pair.reasons as unknown as Prisma.InputJsonValue,
          },
        });
        candidatesRefreshed++;
      } else {
        candidatesSkippedDecided++; // human already decided (MERGED/REJECTED) — never resurrect
      }
    }

    // Rebuild groups: connected components over SUGGESTED pairs between ACTIVE citations.
    const suggested = await tx.deduplicationCandidate.findMany({
      where: {
        projectId,
        status: "SUGGESTED",
        citationA: { status: "ACTIVE" },
        citationB: { status: "ACTIVE" },
      },
    });

    const parent = new Map<string, string>();
    const find = (x: string): string => {
      let root = parent.get(x) ?? x;
      while (root !== (parent.get(root) ?? root)) root = parent.get(root) ?? root;
      parent.set(x, root);
      return root;
    };
    const union = (x: string, y: string) => {
      const rx = find(x);
      const ry = find(y);
      if (rx !== ry) parent.set(rx, ry);
    };
    for (const c of suggested) union(c.citationAId, c.citationBId);

    const components = new Map<string, typeof suggested>();
    for (const c of suggested) {
      const root = find(c.citationAId);
      const list = components.get(root);
      if (list) list.push(c);
      else components.set(root, [c]);
    }

    const usedGroupIds = new Set<string>();
    let groupsOpen = 0;
    for (const members of components.values()) {
      const existingGroupIds = [
        ...new Set(members.map((c) => c.groupId).filter((id): id is string => id !== null)),
      ];
      const reuseId = existingGroupIds.find((id) => !usedGroupIds.has(id));
      let groupId: string;
      if (reuseId) {
        groupId = reuseId;
        await tx.deduplicationGroup.update({ where: { id: groupId }, data: { status: "OPEN" } });
      } else {
        const group = await tx.deduplicationGroup.create({ data: { projectId } });
        groupId = group.id;
      }
      usedGroupIds.add(groupId);
      const stale = members.filter((c) => c.groupId !== groupId).map((c) => c.id);
      if (stale.length > 0) {
        await tx.deduplicationCandidate.updateMany({
          where: { id: { in: stale } },
          data: { groupId },
        });
      }
      groupsOpen++;
    }

    // OPEN groups left without any SUGGESTED pair: resolve them (delete if fully empty —
    // e.g. after two groups fused into one component).
    const orphanedGroups = await tx.deduplicationGroup.findMany({
      where: { projectId, status: "OPEN", id: { notIn: [...usedGroupIds] } },
      include: { _count: { select: { candidates: true } } },
    });
    for (const group of orphanedGroups) {
      if (group._count.candidates === 0) {
        await tx.deduplicationGroup.delete({ where: { id: group.id } });
      } else {
        await tx.deduplicationGroup.update({
          where: { id: group.id },
          data: { status: "RESOLVED" },
        });
      }
    }

    const summary = {
      citationsScanned: citations.length,
      pairsDetected: pairs.length,
      candidatesCreated,
      candidatesRefreshed,
      candidatesSkippedDecided,
      groupsOpen,
    };
    await audit.record(tx, {
      projectId,
      userId: ctx.userId,
      entityType: "Project",
      entityId: projectId,
      action: AuditActions.DEDUP_RUN,
      metadata: summary,
    });
    return summary;
  });
}

// Groups with candidate pairs, evidence, and full citation payloads for side-by-side compare.
export async function listGroups(
  ctx: Ctx,
  projectId: string,
  query: z.infer<typeof listGroupsQuerySchema> = {},
) {
  await requirePermission(ctx, projectId, "project.view");
  return prisma.deduplicationGroup.findMany({
    where: { projectId, status: query.status ?? "OPEN" },
    orderBy: { createdAt: "asc" },
    include: {
      candidates: {
        orderBy: { score: "desc" },
        include: {
          citationA: { include: { identifiers: true } },
          citationB: { include: { identifiers: true } },
          decidedBy: { select: { id: true, name: true, email: true } },
        },
      },
    },
  });
}

// Merge a group into a canonical citation (R8 + R17). Every other ACTIVE member becomes
// DUPLICATE; its PENDING assignments and OPEN conflicts are voided (ids recorded in the
// audit metadata so undo can restore them).
export async function mergeGroup(
  ctx: Ctx,
  projectId: string,
  groupId: string,
  input: z.infer<typeof mergeGroupSchema>,
) {
  await requirePermission(ctx, projectId, "dedup.manage");

  return prisma.$transaction(async (tx) => {
    const group = await tx.deduplicationGroup.findFirst({
      where: { id: groupId, projectId },
      include: { candidates: true },
    });
    if (!group) throw notFound("Deduplication group");
    if (group.status !== "OPEN") throw invalidState("This group has already been resolved");

    // Membership = citations connected by still-SUGGESTED pairs (rejected pairs don't merge).
    const suggested = group.candidates.filter((c) => c.status === "SUGGESTED");
    if (suggested.length === 0) {
      throw invalidState("This group has no suggested candidates left to merge");
    }
    const memberIds = new Set<string>();
    for (const cand of suggested) {
      memberIds.add(cand.citationAId);
      memberIds.add(cand.citationBId);
    }
    if (!memberIds.has(input.canonicalCitationId)) {
      throw invalidState("Canonical citation must be a member of this group");
    }
    const canonical = await tx.citation.findFirst({
      where: { id: input.canonicalCitationId, projectId },
    });
    if (!canonical) throw notFound("Citation");
    if (canonical.status !== "ACTIVE") {
      throw invalidState("Canonical citation must be ACTIVE");
    }

    const duplicates = await tx.citation.findMany({
      where: {
        id: { in: [...memberIds].filter((id) => id !== canonical.id) },
        projectId,
        status: "ACTIVE",
      },
    });

    // R8 warning: both canonical and a duplicate already carry screening decisions.
    const decisionRows = await tx.screeningDecision.findMany({
      where: { citationId: { in: [canonical.id, ...duplicates.map((d) => d.id)] } },
      select: { citationId: true },
    });
    const citationIdsWithDecisions = new Set(decisionRows.map((d) => d.citationId));

    const mergedCitationIds: string[] = [];
    const voidedAssignmentIds: string[] = [];
    const voidedConflictIds: string[] = [];
    for (const dup of duplicates) {
      const pendingAssignments = await tx.screeningAssignment.findMany({
        where: { citationId: dup.id, status: "PENDING" },
        select: { id: true },
      });
      const openConflicts = await tx.screeningConflict.findMany({
        where: { citationId: dup.id, status: "OPEN" },
        select: { id: true },
      });
      const dupVoidedAssignmentIds = pendingAssignments.map((a) => a.id);
      const dupVoidedConflictIds = openConflicts.map((c) => c.id);
      if (dupVoidedAssignmentIds.length > 0) {
        await tx.screeningAssignment.updateMany({
          where: { id: { in: dupVoidedAssignmentIds } },
          data: { status: "VOIDED" },
        });
      }
      if (dupVoidedConflictIds.length > 0) {
        await tx.screeningConflict.updateMany({
          where: { id: { in: dupVoidedConflictIds } },
          data: { status: "VOIDED" },
        });
      }
      await tx.citation.update({
        where: { id: dup.id },
        data: { status: "DUPLICATE", duplicateOfId: canonical.id },
      });
      await audit.record(tx, {
        projectId,
        userId: ctx.userId,
        entityType: "Citation",
        entityId: dup.id,
        action: AuditActions.DEDUP_MERGED,
        previousValue: { status: "ACTIVE" },
        newValue: { status: "DUPLICATE", duplicateOfId: canonical.id },
        metadata: {
          groupId,
          voidedAssignmentIds: dupVoidedAssignmentIds,
          voidedConflictIds: dupVoidedConflictIds,
        },
      });
      mergedCitationIds.push(dup.id);
      voidedAssignmentIds.push(...dupVoidedAssignmentIds);
      voidedConflictIds.push(...dupVoidedConflictIds);
    }

    const decidedAt = new Date();
    await tx.deduplicationCandidate.updateMany({
      where: { groupId, status: "SUGGESTED" },
      data: { status: "MERGED", decidedById: ctx.userId, decidedAt },
    });
    const resolvedGroup = await tx.deduplicationGroup.update({
      where: { id: groupId },
      data: { status: "RESOLVED" },
    });

    const duplicatesWithDecisions = mergedCitationIds.filter((id) =>
      citationIdsWithDecisions.has(id),
    );
    const warning =
      citationIdsWithDecisions.has(canonical.id) && duplicatesWithDecisions.length > 0
        ? {
            code: "SCREENING_DECISIONS_ON_BOTH" as const,
            message:
              "Both the canonical citation and a merged duplicate already have screening " +
              "decisions. The canonical citation's screening history is authoritative; the " +
              "duplicate's decisions are kept for the record but ignored.",
            canonicalCitationId: canonical.id,
            duplicateCitationIdsWithDecisions: duplicatesWithDecisions,
          }
        : null;

    return {
      group: resolvedGroup,
      canonicalCitationId: canonical.id,
      mergedCitationIds,
      voidedAssignmentIds,
      voidedConflictIds,
      warning,
    };
  });
}

// Reject a suggested pair. When the group has no SUGGESTED pair left it is RESOLVED.
export async function rejectCandidate(ctx: Ctx, projectId: string, candidateId: string) {
  await requirePermission(ctx, projectId, "dedup.manage");

  return prisma.$transaction(async (tx) => {
    const candidate = await tx.deduplicationCandidate.findFirst({
      where: { id: candidateId, projectId },
    });
    if (!candidate) throw notFound("Deduplication candidate");
    if (candidate.status !== "SUGGESTED") {
      throw invalidState("Only suggested candidates can be rejected");
    }
    const updated = await tx.deduplicationCandidate.update({
      where: { id: candidate.id },
      data: { status: "REJECTED", decidedById: ctx.userId, decidedAt: new Date() },
    });
    await audit.record(tx, {
      projectId,
      userId: ctx.userId,
      entityType: "DeduplicationCandidate",
      entityId: candidate.id,
      action: AuditActions.DEDUP_REJECTED,
      previousValue: { status: "SUGGESTED" },
      newValue: { status: "REJECTED" },
      metadata: {
        groupId: candidate.groupId,
        citationAId: candidate.citationAId,
        citationBId: candidate.citationBId,
      },
    });

    let groupResolved = false;
    if (candidate.groupId) {
      const remaining = await tx.deduplicationCandidate.count({
        where: { groupId: candidate.groupId, status: "SUGGESTED" },
      });
      if (remaining === 0) {
        await tx.deduplicationGroup.update({
          where: { id: candidate.groupId },
          data: { status: "RESOLVED" },
        });
        groupResolved = true;
      }
    }
    return { candidate: updated, groupResolved };
  });
}

// Undo a merge for one merged citation. The restore payload comes from the audit metadata
// of its latest DEDUP_MERGED event (R8: restore voided assignments/conflicts to prior status).
export async function undoMerge(ctx: Ctx, projectId: string, citationId: string) {
  await requirePermission(ctx, projectId, "dedup.manage");

  return prisma.$transaction(async (tx) => {
    const citation = await tx.citation.findFirst({ where: { id: citationId, projectId } });
    if (!citation) throw notFound("Citation");
    if (citation.status !== "DUPLICATE") {
      throw invalidState("Only citations merged as duplicates can be restored");
    }

    const mergeEvent = await tx.auditEvent.findFirst({
      where: {
        projectId,
        entityType: "Citation",
        entityId: citation.id,
        action: AuditActions.DEDUP_MERGED,
      },
      orderBy: { createdAt: "desc" },
    });
    if (!mergeEvent) {
      throw invalidState("No merge event found for this citation — cannot undo");
    }
    const meta = (mergeEvent.metadata ?? {}) as unknown as MergeAuditMetadata;
    const restoredAssignmentIds = meta.voidedAssignmentIds ?? [];
    const restoredConflictIds = meta.voidedConflictIds ?? [];
    const groupId = meta.groupId ?? null;

    const restored = await tx.citation.update({
      where: { id: citation.id },
      data: { status: "ACTIVE", duplicateOfId: null },
    });
    if (restoredAssignmentIds.length > 0) {
      await tx.screeningAssignment.updateMany({
        where: { id: { in: restoredAssignmentIds }, status: "VOIDED" },
        data: { status: "PENDING" },
      });
    }
    if (restoredConflictIds.length > 0) {
      await tx.screeningConflict.updateMany({
        where: { id: { in: restoredConflictIds }, status: "VOIDED" },
        data: { status: "OPEN", resolvedAt: null },
      });
    }
    if (groupId) {
      await tx.deduplicationCandidate.updateMany({
        where: {
          groupId,
          status: "MERGED",
          OR: [{ citationAId: citation.id }, { citationBId: citation.id }],
        },
        data: { status: "SUGGESTED", decidedById: null, decidedAt: null },
      });
      await tx.deduplicationGroup.updateMany({
        where: { id: groupId, projectId },
        data: { status: "OPEN" },
      });
    }

    await audit.record(tx, {
      projectId,
      userId: ctx.userId,
      entityType: "Citation",
      entityId: citation.id,
      action: AuditActions.DEDUP_MERGE_UNDONE,
      previousValue: { status: "DUPLICATE", duplicateOfId: citation.duplicateOfId },
      newValue: { status: "ACTIVE", duplicateOfId: null },
      metadata: { groupId, restoredAssignmentIds, restoredConflictIds },
    });

    return { citation: restored, groupId, restoredAssignmentIds, restoredConflictIds };
  });
}
