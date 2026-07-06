// PRISMA 2020 flow-diagram counts — always computed live from base tables (R3: stage results
// are the definition of stage progression; R4: quantitative-synthesis flag on Study).
// Snapshots freeze the computed report into PrismaSnapshot + PrismaCount rows.

import { z } from "zod";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/server/db";
import { notFound } from "@/server/errors";
import type { Ctx } from "@/server/auth/session";
import { requirePermission } from "@/server/permissions";
import * as audit from "@/server/services/audit";
import { AuditActions } from "@/server/services/audit";

export const createSnapshotSchema = z.object({
  label: z.string().trim().min(1).max(200),
});

export interface PrismaCountRow {
  key: string;
  label: string;
  value: number;
  breakdown?: Record<string, number>;
}

export interface PrismaReport {
  counts: PrismaCountRow[];
  computedAt: string;
}

export const NO_REASON_LABEL = "(no reason recorded)";

// Pure computation — no authorization; callers gate access.
export async function computePrismaCounts(projectId: string): Promise<PrismaReport> {
  // -- records_identified: committed source records, by import-source name -------------------
  const committedBatches = await prisma.importBatch.findMany({
    where: { projectId, status: "COMMITTED" },
    select: {
      source: { select: { name: true } },
      _count: { select: { sourceRecords: { where: { citationId: { not: null } } } } },
    },
  });
  const bySource: Record<string, number> = {};
  let recordsIdentified = 0;
  for (const batch of committedBatches) {
    recordsIdentified += batch._count.sourceRecords;
    bySource[batch.source.name] = (bySource[batch.source.name] ?? 0) + batch._count.sourceRecords;
  }

  // -- duplicates_removed ---------------------------------------------------------------------
  const duplicatesRemoved = await prisma.citation.count({
    where: { projectId, status: "DUPLICATE" },
  });

  // -- records_screened: ACTIVE citations with any TA decision OR a TA stage result -----------
  const recordsScreened = await prisma.citation.count({
    where: {
      projectId,
      status: "ACTIVE",
      OR: [
        { decisions: { some: { stage: { type: "TITLE_ABSTRACT" } } } },
        { stageResults: { some: { stage: { type: "TITLE_ABSTRACT" } } } },
      ],
    },
  });

  // -- TA stage results (ACTIVE citations only — R8) -------------------------------------------
  const recordsExcludedTa = await prisma.citationStageResult.count({
    where: {
      stage: { projectId, type: "TITLE_ABSTRACT" },
      outcome: "EXCLUDE",
      citation: { status: "ACTIVE" },
    },
  });
  const reportsSought = await prisma.citationStageResult.count({
    where: {
      stage: { projectId, type: "TITLE_ABSTRACT" },
      outcome: "INCLUDE",
      citation: { status: "ACTIVE" },
    },
  });

  // -- reports_not_retrieved: sought, zero full-text links, latest attempt NOT_RETRIEVED ------
  const soughtWithoutFile = await prisma.citation.findMany({
    where: {
      projectId,
      status: "ACTIVE",
      stageResults: { some: { stage: { type: "TITLE_ABSTRACT" }, outcome: "INCLUDE" } },
      fullTextLinks: { none: {} },
    },
    select: {
      retrievalAttempts: {
        orderBy: [{ attemptedAt: "desc" }, { id: "desc" }],
        take: 1,
        select: { outcome: true },
      },
    },
  });
  const reportsNotRetrieved = soughtWithoutFile.filter(
    (c) => c.retrievalAttempts[0]?.outcome === "NOT_RETRIEVED",
  ).length;

  // -- reports_assessed: ACTIVE citations with any FT decision OR an FT stage result ----------
  const reportsAssessed = await prisma.citation.count({
    where: {
      projectId,
      status: "ACTIVE",
      OR: [
        { decisions: { some: { stage: { type: "FULL_TEXT" } } } },
        { stageResults: { some: { stage: { type: "FULL_TEXT" } } } },
      ],
    },
  });

  // -- reports_excluded: FT EXCLUDE results, breakdown by exclusion-reason label --------------
  const ftExcludeResults = await prisma.citationStageResult.findMany({
    where: {
      stage: { projectId, type: "FULL_TEXT" },
      outcome: "EXCLUDE",
      citation: { status: "ACTIVE" },
    },
    select: { stageId: true, citationId: true, resolvedVia: true },
  });
  const byReason: Record<string, number> = {};
  if (ftExcludeResults.length > 0) {
    const citationIds = ftExcludeResults.map((r) => r.citationId);
    const stageIds = [...new Set(ftExcludeResults.map((r) => r.stageId))];
    // Adjudications carry the authoritative reason for ADJUDICATION-resolved results.
    const conflicts = await prisma.screeningConflict.findMany({
      where: { stageId: { in: stageIds }, citationId: { in: citationIds } },
      select: {
        stageId: true,
        citationId: true,
        adjudication: { select: { exclusionReason: { select: { label: true } } } },
      },
    });
    const adjudicatedReason = new Map<string, string>();
    for (const c of conflicts) {
      const label = c.adjudication?.exclusionReason?.label;
      if (label) adjudicatedReason.set(`${c.stageId}:${c.citationId}`, label);
    }
    // Otherwise: first non-null exclusion reason among the citation's FT decisions.
    const decisions = await prisma.screeningDecision.findMany({
      where: {
        stageId: { in: stageIds },
        citationId: { in: citationIds },
        exclusionReasonId: { not: null },
      },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      select: {
        stageId: true,
        citationId: true,
        exclusionReason: { select: { label: true } },
      },
    });
    const firstDecisionReason = new Map<string, string>();
    for (const d of decisions) {
      const key = `${d.stageId}:${d.citationId}`;
      if (!firstDecisionReason.has(key) && d.exclusionReason) {
        firstDecisionReason.set(key, d.exclusionReason.label);
      }
    }
    for (const r of ftExcludeResults) {
      const key = `${r.stageId}:${r.citationId}`;
      const label =
        (r.resolvedVia === "ADJUDICATION" ? adjudicatedReason.get(key) : undefined) ??
        firstDecisionReason.get(key) ??
        NO_REASON_LABEL;
      byReason[label] = (byReason[label] ?? 0) + 1;
    }
  }

  // -- included studies / reports (R4) ---------------------------------------------------------
  const studiesIncluded = await prisma.study.count({ where: { projectId } });
  const reportsIncluded = await prisma.studyReportLink.count({
    where: { study: { projectId } },
  });
  const studiesInQuantitativeSynthesis = await prisma.study.count({
    where: { projectId, inQuantitativeSynthesis: true },
  });

  const counts: PrismaCountRow[] = [
    {
      key: "records_identified",
      label: "Records identified",
      value: recordsIdentified,
      breakdown: bySource,
    },
    { key: "duplicates_removed", label: "Duplicate records removed", value: duplicatesRemoved },
    { key: "records_screened", label: "Records screened", value: recordsScreened },
    {
      key: "records_excluded_ta",
      label: "Records excluded (title/abstract)",
      value: recordsExcludedTa,
    },
    { key: "reports_sought", label: "Reports sought for retrieval", value: reportsSought },
    { key: "reports_not_retrieved", label: "Reports not retrieved", value: reportsNotRetrieved },
    { key: "reports_assessed", label: "Reports assessed for eligibility", value: reportsAssessed },
    {
      key: "reports_excluded",
      label: "Reports excluded",
      value: ftExcludeResults.length,
      breakdown: byReason,
    },
    { key: "studies_included", label: "Studies included in review", value: studiesIncluded },
    { key: "reports_included", label: "Reports of included studies", value: reportsIncluded },
    {
      key: "studies_in_quantitative_synthesis",
      label: "Studies included in quantitative synthesis (meta-analysis)",
      value: studiesInQuantitativeSynthesis,
    },
  ];

  return { counts, computedAt: new Date().toISOString() };
}

export async function getLivePrismaCounts(ctx: Ctx, projectId: string): Promise<PrismaReport> {
  await requirePermission(ctx, projectId, "project.view");
  return computePrismaCounts(projectId);
}

export async function createPrismaSnapshot(
  ctx: Ctx,
  projectId: string,
  input: z.infer<typeof createSnapshotSchema>,
) {
  await requirePermission(ctx, projectId, "prisma.snapshot");
  const report = await computePrismaCounts(projectId);
  return prisma.$transaction(async (tx) => {
    const snapshot = await tx.prismaSnapshot.create({
      data: {
        projectId,
        label: input.label,
        data: report as unknown as Prisma.InputJsonValue,
        createdById: ctx.userId,
        counts: {
          create: report.counts.map((c) => ({
            key: c.key,
            label: c.label,
            value: c.value,
            breakdown: c.breakdown as Prisma.InputJsonValue | undefined,
          })),
        },
      },
      include: {
        counts: true,
        createdBy: { select: { id: true, name: true } },
      },
    });
    await audit.record(tx, {
      projectId,
      userId: ctx.userId,
      entityType: "PrismaSnapshot",
      entityId: snapshot.id,
      action: AuditActions.PRISMA_SNAPSHOT_CREATED,
      newValue: { label: snapshot.label, computedAt: report.computedAt },
    });
    return snapshot;
  });
}

export async function listPrismaSnapshots(ctx: Ctx, projectId: string) {
  await requirePermission(ctx, projectId, "project.view");
  return prisma.prismaSnapshot.findMany({
    where: { projectId },
    orderBy: { createdAt: "desc" },
    select: {
      id: true,
      label: true,
      createdAt: true,
      createdBy: { select: { id: true, name: true } },
    },
  });
}

export async function getPrismaSnapshot(ctx: Ctx, projectId: string, snapshotId: string) {
  await requirePermission(ctx, projectId, "project.view");
  // R9: tenant-scoped by-id load.
  const snapshot = await prisma.prismaSnapshot.findFirst({
    where: { id: snapshotId, projectId },
    include: {
      counts: true,
      createdBy: { select: { id: true, name: true } },
    },
  });
  if (!snapshot) throw notFound("PRISMA snapshot");
  return snapshot;
}
