import { z } from "zod";
import { prisma } from "@/server/db";
import type { Ctx } from "@/server/auth/session";
import { requirePermission } from "@/server/permissions";
import { invalidState, notFound } from "@/server/errors";
import * as audit from "@/server/services/audit";
import { AuditActions } from "@/server/services/audit";
import {
  companionGraph,
  reconcileIncludedCompanions,
} from "@/server/services/studies/companions";
import { lockDedupProject, normalizeGroups } from "./groups";

// Snapshot of the reviewed cluster prevents a stale confirmation from deciding new imports.
export const confirmCompanionGroupSchema = z.object({
  confirmed: z.literal(true),
  candidateIds: z.array(z.string().min(1)).min(1).max(10000),
});

export async function confirmCompanions(
  ctx: Ctx,
  projectId: string,
  target:
    | { candidateId: string }
    | { groupId: string; candidateIds: string[]; confirmed: true },
) {
  await requirePermission(ctx, projectId, "dedup.manage");
  return prisma.$transaction(
    async (tx) => {
      await lockDedupProject(tx, projectId);
      await normalizeGroups(tx, projectId);
      const candidates = await tx.deduplicationCandidate.findMany({
        where: {
          projectId,
          ...("candidateId" in target
            ? { id: target.candidateId }
            : { groupId: target.groupId, status: "SUGGESTED" }),
        },
        include: { citationA: true, citationB: true },
      });
      if (!candidates.length) throw notFound("Suggested deduplication pair");
      if (
        "groupId" in target &&
        (target.confirmed !== true ||
          new Set(target.candidateIds).size !== candidates.length ||
          candidates.some((c) => !target.candidateIds.includes(c.id)))
      ) {
        throw invalidState(
          "The cluster has changed. Refresh and confirm its current pairs.",
        );
      }
      for (const c of candidates) {
        if (
          c.status !== "SUGGESTED" ||
          c.citationA.projectId !== projectId ||
          c.citationB.projectId !== projectId ||
          c.citationA.status !== "ACTIVE" ||
          c.citationB.status !== "ACTIVE" ||
          c.citationAId === c.citationBId
        ) {
          throw invalidState(
            "Only suggested pairs of active citations can be confirmed. Refresh first.",
          );
        }
        await tx.deduplicationCandidate.update({
          where: { id: c.id },
          data: {
            status: "COMPANION",
            decidedAt: new Date(),
            decidedById: ctx.userId,
          },
        });
        await audit.record(tx, {
          projectId,
          userId: ctx.userId,
          entityType: "DeduplicationCandidate",
          entityId: c.id,
          action: AuditActions.DEDUP_COMPANION_CONFIRMED,
          previousValue: { status: c.status },
          newValue: { status: "COMPANION" },
          metadata: {
            citationAId: c.citationAId,
            citationBId: c.citationBId,
            groupId: c.groupId,
          },
        });
      }
      const graph = await companionGraph(tx, projectId);
      const visited = new Set<string>();
      for (const c of candidates) {
        if (visited.has(c.citationAId)) continue;
        const members = graph.members(c.citationAId);
        members.forEach((id) => visited.add(id));
        const eligible = await tx.citation.findMany({
          where: {
            projectId,
            id: { in: [...members] },
            status: "ACTIVE",
            stageResults: {
              some: {
                stage: { projectId, type: "FULL_TEXT" },
                outcome: "INCLUDE",
              },
            },
          },
          select: { studyLinks: { select: { studyId: true } } },
        });
        // An early dedup decision needs only dedup.manage. An immediate analysis mutation
        // must additionally satisfy the existing manual study-management permission.
        if (eligible.length > 0) {
          const studyIds = new Set(
            eligible.flatMap((c) => c.studyLinks.map((l) => l.studyId)),
          );
          const needsStudyWrite =
            eligible.some((c) => c.studyLinks.length === 0) ||
            studyIds.size > 1;
          if (needsStudyWrite)
            await requirePermission(ctx, projectId, "project.edit", tx);
          await reconcileIncludedCompanions(tx, ctx, projectId, c.citationAId);
        }
      }
      await normalizeGroups(tx, projectId);
      return { confirmed: candidates.length };
    },
    { timeout: 60_000 },
  );
}

export async function reopenDecision(
  ctx: Ctx,
  projectId: string,
  candidateId: string,
) {
  await requirePermission(ctx, projectId, "dedup.manage");
  return prisma.$transaction(async (tx) => {
    await lockDedupProject(tx, projectId);
    const c = await tx.deduplicationCandidate.findFirst({
      where: { id: candidateId, projectId },
      include: { citationA: true, citationB: true },
    });
    if (!c) throw notFound("Deduplication candidate");
    if (c.status !== "COMPANION" && c.status !== "REJECTED")
      throw invalidState(
        "Only not-duplicate or companion decisions can be reopened here. Use merge undo for merged citations.",
      );
    if (c.status === "COMPANION") {
      const graph = await companionGraph(tx, projectId);
      const members = graph.members(c.citationAId);
      const applied = await tx.auditEvent.findFirst({
        where: {
          projectId,
          entityId: c.id,
          entityType: "DeduplicationCandidate",
          action: AuditActions.DEDUP_COMPANION_APPLIED,
        },
      });
      const linked = await tx.studyReportLink.count({
        where: { citationId: { in: [...members] }, study: { projectId } },
      });
      if (applied || linked > 1)
        throw invalidState(
          "This companion judgment has study linkage depending on it. No reports were unlinked. Reconcile the reports and downstream work in the companion/study workflow before revising this relationship.",
        );
    }
    if (
      c.citationA.projectId !== projectId ||
      c.citationB.projectId !== projectId ||
      c.citationA.status !== "ACTIVE" ||
      c.citationB.status !== "ACTIVE"
    ) {
      throw invalidState(
        "Restore merged citation records before reopening their historical relationship.",
      );
    }
    await tx.deduplicationCandidate.update({
      where: { id: c.id },
      data: { status: "SUGGESTED", decidedAt: null, decidedById: null },
    });
    await audit.record(tx, {
      projectId,
      userId: ctx.userId,
      entityType: "DeduplicationCandidate",
      entityId: c.id,
      action: AuditActions.DEDUP_DECISION_REOPENED,
      previousValue: {
        status: c.status,
        decidedById: c.decidedById,
        decidedAt: c.decidedAt?.toISOString(),
      },
      newValue: { status: "SUGGESTED" },
      metadata: { citationAId: c.citationAId, citationBId: c.citationBId },
    });
    await normalizeGroups(tx, projectId);
    return { reopened: true };
  });
}
