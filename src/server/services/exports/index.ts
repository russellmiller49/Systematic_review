// Exports (R1 gating): CITATIONS / PRISMA need export.create; SCREENING / EXTRACTION / ROB /
// AUDIT / FULL additionally require project.edit (they can contain blinded work products).
// MVP: content is generated on demand — the ExportJob row records the request (COMPLETED,
// storageKey null) and download regenerates + streams after re-checking the same gating.

import { z } from "zod";
import type { ExportFormat, ExportKind } from "@prisma/client";
import { prisma } from "@/server/db";
import { notFound, validationError } from "@/server/errors";
import type { Ctx } from "@/server/auth/session";
import { requirePermission, type Capability } from "@/server/permissions";
import * as audit from "@/server/services/audit";
import { AuditActions } from "@/server/services/audit";
import { computePrismaCounts } from "@/server/services/prisma-report";
import { toCsv, toJsonBody, type CsvRow } from "./serializers";

export const createExportSchema = z.object({
  kind: z.enum(["CITATIONS", "SCREENING", "EXTRACTION", "ROB", "PRISMA", "AUDIT", "FULL"]),
  format: z.enum(["CSV", "JSON"]),
});

export type CreateExportInput = z.infer<typeof createExportSchema>;

// R1: which capability unlocks each export kind.
export function exportCapability(kind: ExportKind): Capability {
  return kind === "CITATIONS" || kind === "PRISMA" ? "export.create" : "project.edit";
}

const CSV_BOM = "\uFEFF";

export async function createExport(ctx: Ctx, projectId: string, input: CreateExportInput) {
  await requirePermission(ctx, projectId, exportCapability(input.kind));
  if (input.kind === "FULL" && input.format === "CSV") {
    throw validationError("FULL export is only available as JSON");
  }
  return prisma.$transaction(async (tx) => {
    const job = await tx.exportJob.create({
      data: {
        projectId,
        kind: input.kind,
        format: input.format,
        status: "COMPLETED", // MVP: generated on demand at download time
        storageKey: null,
        completedAt: new Date(),
        requestedById: ctx.userId,
      },
      include: { requestedBy: { select: { id: true, name: true } } },
    });
    await audit.record(tx, {
      projectId,
      userId: ctx.userId,
      entityType: "ExportJob",
      entityId: job.id,
      action: AuditActions.EXPORT_CREATED,
      newValue: { kind: job.kind, format: job.format },
    });
    return job;
  });
}

export async function listExports(ctx: Ctx, projectId: string) {
  await requirePermission(ctx, projectId, "export.create");
  return prisma.exportJob.findMany({
    where: { projectId },
    orderBy: { createdAt: "desc" },
    include: { requestedBy: { select: { id: true, name: true } } },
  });
}

export interface ExportFile {
  filename: string;
  contentType: string;
  body: string; // CSV bodies already carry the UTF-8 BOM
}

export async function downloadExport(
  ctx: Ctx,
  projectId: string,
  jobId: string,
): Promise<ExportFile> {
  await requirePermission(ctx, projectId, "project.view");
  // R9: tenant-scoped by-id load.
  const job = await prisma.exportJob.findFirst({ where: { id: jobId, projectId } });
  if (!job) throw notFound("Export job");
  // R1: downloading re-checks the same gating as creation.
  await requirePermission(ctx, projectId, exportCapability(job.kind));
  if (job.kind === "FULL" && job.format === "CSV") {
    throw validationError("FULL export is only available as JSON");
  }
  const body = await generateExportBody(projectId, job.kind, job.format);
  const ext = job.format === "CSV" ? "csv" : "json";
  return {
    filename: `${job.kind.toLowerCase()}-${projectId}.${ext}`,
    contentType:
      job.format === "CSV" ? "text/csv; charset=utf-8" : "application/json",
    body: job.format === "CSV" ? CSV_BOM + body : body,
  };
}

// ---------------------------------------------------------------------------
// Content generation
// ---------------------------------------------------------------------------

function formatAuthors(authors: unknown): string {
  if (!Array.isArray(authors)) return "";
  return authors
    .map((a) => {
      if (typeof a === "string") return a;
      const o = a as { family?: string; given?: string; raw?: string };
      const name = [o.family, o.given].filter(Boolean).join(", ");
      return name || o.raw || "";
    })
    .filter((s) => s.length > 0)
    .join("; ");
}

function stringifyOrNull(value: unknown): string | null {
  return value === null || value === undefined ? null : JSON.stringify(value);
}

async function citationRows(projectId: string): Promise<CsvRow[]> {
  const citations = await prisma.citation.findMany({
    where: { projectId },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    include: {
      sourceRecords: {
        select: { batch: { select: { source: { select: { name: true } } } } },
      },
    },
  });
  return citations.map((c) => ({
    id: c.id,
    status: c.status,
    title: c.title,
    authors: formatAuthors(c.authors),
    year: c.year,
    journal: c.journal,
    volume: c.volume,
    issue: c.issue,
    pages: c.pages,
    doi: c.doi,
    pmid: c.pmid,
    url: c.url,
    duplicateOfId: c.duplicateOfId,
    sources: [...new Set(c.sourceRecords.map((r) => r.batch.source.name))].join("; "),
  }));
}

interface ScreeningSections {
  decisions: CsvRow[];
  adjudications: CsvRow[];
  stageResults: CsvRow[];
}

async function screeningSections(projectId: string): Promise<ScreeningSections> {
  const decisions = await prisma.screeningDecision.findMany({
    where: { stage: { projectId } },
    orderBy: [{ updatedAt: "asc" }, { id: "asc" }],
    include: {
      stage: { select: { type: true } },
      citation: { select: { title: true } },
      reviewer: { select: { name: true } },
      exclusionReason: { select: { label: true } },
    },
  });
  const adjudications = await prisma.screeningAdjudication.findMany({
    where: { conflict: { stage: { projectId } } },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    include: {
      conflict: { include: { stage: { select: { type: true } } } },
      adjudicator: { select: { name: true } },
      exclusionReason: { select: { label: true } },
    },
  });
  const stageResults = await prisma.citationStageResult.findMany({
    where: { stage: { projectId } },
    orderBy: [{ resolvedAt: "asc" }, { id: "asc" }],
    include: { stage: { select: { type: true } } },
  });
  return {
    decisions: decisions.map((d) => ({
      stage: d.stage.type,
      citationId: d.citationId,
      title: d.citation.title,
      reviewerName: d.reviewer.name,
      decision: d.decision,
      exclusionReason: d.exclusionReason?.label ?? null,
      notes: d.notes,
      labels: d.labels.join("; "),
      updatedAt: d.updatedAt,
    })),
    adjudications: adjudications.map((a) => ({
      stage: a.conflict.stage.type,
      citationId: a.conflict.citationId,
      adjudicatorName: a.adjudicator.name,
      finalDecision: a.finalDecision,
      exclusionReason: a.exclusionReason?.label ?? null,
      reason: a.reason,
      createdAt: a.createdAt,
    })),
    stageResults: stageResults.map((r) => ({
      stage: r.stage.type,
      citationId: r.citationId,
      outcome: r.outcome,
      resolvedVia: r.resolvedVia,
      resolvedAt: r.resolvedAt,
    })),
  };
}

interface ExtractionSections {
  values: CsvRow[];
  adjudications: CsvRow[];
}

async function extractionSections(projectId: string): Promise<ExtractionSections> {
  const values = await prisma.extractionValue.findMany({
    where: { form: { study: { projectId } } },
    orderBy: [{ updatedAt: "asc" }, { id: "asc" }],
    include: {
      field: { select: { key: true } },
      form: {
        include: {
          study: { select: { label: true } },
          template: { select: { name: true } },
          extractor: { select: { name: true } },
        },
      },
    },
  });
  const adjudications = await prisma.extractionAdjudication.findMany({
    where: { conflict: { study: { projectId } } },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    include: {
      conflict: {
        include: {
          study: { select: { label: true } },
          template: { select: { name: true } },
          field: { select: { key: true } },
        },
      },
      adjudicator: { select: { name: true } },
    },
  });
  return {
    values: values.map((v) => ({
      study: v.form.study.label,
      template: v.form.template.name,
      fieldKey: v.field.key,
      extractorName: v.form.extractor.name,
      value: stringifyOrNull(v.value),
      sourceQuote: v.sourceQuote,
      pageNumber: v.pageNumber,
      notes: v.notes,
    })),
    adjudications: adjudications.map((a) => ({
      study: a.conflict.study.label,
      template: a.conflict.template.name,
      fieldKey: a.conflict.field.key,
      adjudicatorName: a.adjudicator.name,
      finalValue: stringifyOrNull(a.finalValue),
      reason: a.reason,
      createdAt: a.createdAt,
    })),
  };
}

interface RobSections {
  judgments: CsvRow[];
  overall: CsvRow[];
  adjudications: CsvRow[];
}

async function robSections(projectId: string): Promise<RobSections> {
  const judgments = await prisma.riskOfBiasJudgment.findMany({
    where: { assessment: { study: { projectId } } },
    orderBy: [{ updatedAt: "asc" }, { id: "asc" }],
    include: {
      domain: { select: { name: true } },
      assessment: {
        include: {
          study: { select: { label: true } },
          tool: { select: { name: true } },
          assessor: { select: { name: true } },
        },
      },
    },
  });
  const assessments = await prisma.riskOfBiasAssessment.findMany({
    where: { study: { projectId } },
    orderBy: [{ updatedAt: "asc" }, { id: "asc" }],
    include: {
      study: { select: { label: true } },
      tool: { select: { name: true } },
      assessor: { select: { name: true } },
    },
  });
  const adjudications = await prisma.riskOfBiasAdjudication.findMany({
    where: { conflict: { study: { projectId } } },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    include: {
      conflict: {
        include: {
          study: { select: { label: true } },
          tool: { select: { name: true } },
          domain: { select: { name: true } },
        },
      },
      adjudicator: { select: { name: true } },
    },
  });
  return {
    judgments: judgments.map((j) => ({
      study: j.assessment.study.label,
      tool: j.assessment.tool.name,
      domain: j.domain.name,
      assessorName: j.assessment.assessor.name,
      judgment: j.judgment,
      support: j.support,
    })),
    overall: assessments.map((a) => ({
      study: a.study.label,
      tool: a.tool.name,
      assessorName: a.assessor.name,
      overallJudgment: a.overallJudgment,
      status: a.status,
      completedAt: a.completedAt,
    })),
    adjudications: adjudications.map((a) => ({
      study: a.conflict.study.label,
      tool: a.conflict.tool.name,
      domain: a.conflict.domain?.name ?? "(overall)",
      adjudicatorName: a.adjudicator.name,
      finalJudgment: a.finalJudgment,
      reason: a.reason,
      createdAt: a.createdAt,
    })),
  };
}

async function prismaRows(projectId: string): Promise<CsvRow[]> {
  const report = await computePrismaCounts(projectId);
  return report.counts.map((c) => ({
    key: c.key,
    label: c.label,
    value: c.value,
    breakdown: c.breakdown ? JSON.stringify(c.breakdown) : null,
  }));
}

async function auditRows(projectId: string): Promise<CsvRow[]> {
  // AUDIT exports are gated on project.edit (R1) — no blind filter needed here.
  const events = await prisma.auditEvent.findMany({
    where: { projectId },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    include: { user: { select: { name: true } } },
  });
  return events.map((e) => ({
    createdAt: e.createdAt,
    actorName: e.user.name,
    action: e.action,
    entityType: e.entityType,
    entityId: e.entityId,
    reason: e.reason,
    previousValue: stringifyOrNull(e.previousValue),
    newValue: stringifyOrNull(e.newValue),
  }));
}

// Concatenate heterogeneous sections into one CSV with a leading recordType column.
function sectionsToCsv(sections: Record<string, CsvRow[]>): string {
  const rows: CsvRow[] = [];
  for (const [recordType, sectionRows] of Object.entries(sections)) {
    for (const row of sectionRows) rows.push({ recordType, ...row });
  }
  return toCsv(rows);
}

async function generateExportBody(
  projectId: string,
  kind: ExportKind,
  format: ExportFormat,
): Promise<string> {
  switch (kind) {
    case "CITATIONS": {
      const rows = await citationRows(projectId);
      return format === "CSV" ? toCsv(rows) : toJsonBody({ citations: rows });
    }
    case "SCREENING": {
      const sections = await screeningSections(projectId);
      return format === "CSV"
        ? sectionsToCsv({
            decision: sections.decisions,
            adjudication: sections.adjudications,
            stage_result: sections.stageResults,
          })
        : toJsonBody(sections);
    }
    case "EXTRACTION": {
      const sections = await extractionSections(projectId);
      return format === "CSV"
        ? sectionsToCsv({ value: sections.values, adjudication: sections.adjudications })
        : toJsonBody(sections);
    }
    case "ROB": {
      const sections = await robSections(projectId);
      return format === "CSV"
        ? sectionsToCsv({
            judgment: sections.judgments,
            overall: sections.overall,
            adjudication: sections.adjudications,
          })
        : toJsonBody(sections);
    }
    case "PRISMA": {
      const rows = await prismaRows(projectId);
      return format === "CSV" ? toCsv(rows) : toJsonBody({ counts: rows });
    }
    case "AUDIT": {
      const rows = await auditRows(projectId);
      return format === "CSV" ? toCsv(rows) : toJsonBody({ events: rows });
    }
    case "FULL": {
      const [project, protocol, citations, screening, extraction, rob, prismaReport, auditEvents] =
        await Promise.all([
          prisma.project.findUnique({ where: { id: projectId } }),
          prisma.protocol.findUnique({
            where: { projectId },
            include: { picoQuestions: true, criteria: true, outcomes: true },
          }),
          citationRows(projectId),
          screeningSections(projectId),
          extractionSections(projectId),
          robSections(projectId),
          computePrismaCounts(projectId),
          auditRows(projectId),
        ]);
      return toJsonBody({
        project,
        protocol,
        citations,
        screening,
        extraction,
        rob,
        prisma: prismaReport,
        audit: auditEvents,
      });
    }
  }
}
