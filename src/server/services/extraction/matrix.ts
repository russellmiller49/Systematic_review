// Cross-study extraction matrix ("living table"): one row per study, one column per
// template field, each cell resolved to its authoritative value with full provenance
// (extractor entries, quotes, pages, source anchors, adjudications).
//
// Blinding mirrors listForms verbatim: extraction.adjudicate or project.edit holders see
// every extractor's entries plus conflicts/adjudications; everyone else sees only their
// own forms (a personal extraction table) and no conflict/adjudication data.

import { z } from "zod";
import type { FieldType, FormStatus, TemplateStatus } from "@prisma/client";
import { prisma } from "@/server/db";
import { notFound } from "@/server/errors";
import type { Ctx } from "@/server/auth/session";
import { can, requirePermission } from "@/server/permissions";
import { fieldOptions, type FieldOption } from "./validation";
import { resolveMatrixCell, type MatrixEntry, type ResolvedSource } from "./matrix-resolve";

export const matrixQuerySchema = z.object({
  templateId: z.string().min(1),
});

export interface MatrixCell {
  resolved: { value: unknown; source: ResolvedSource } | null;
  disputed: boolean;
  entries: MatrixEntry[];
  adjudication?: {
    finalValue: unknown;
    reason: string;
    adjudicator: { id: string; name: string };
  };
}

export interface MatrixStudyRow {
  id: string;
  label: string;
  inQuantitativeSynthesis: boolean;
  pdf: { fileId: string; filename: string } | null;
  // Keyed by fieldId; fields without any data are simply absent.
  cells: Record<string, MatrixCell>;
}

export interface ExtractionMatrix {
  template: { id: string; name: string; version: number; status: TemplateStatus };
  fields: {
    id: string;
    key: string;
    label: string;
    type: FieldType;
    section: string | null;
    order: number;
    options: FieldOption[];
  }[];
  seeAll: boolean;
  studies: MatrixStudyRow[];
}

// Batched study→PDF resolution mirroring resolveStudyPdf's ordering semantics
// (primary report first, then link id; per citation the oldest linked file wins).
async function resolvePdfsFor(
  projectId: string,
  studyIds: string[],
): Promise<Map<string, { fileId: string; filename: string }>> {
  const links = await prisma.studyReportLink.findMany({
    where: { studyId: { in: studyIds } },
    orderBy: [{ isPrimaryReport: "desc" }, { id: "asc" }],
    select: {
      studyId: true,
      citation: {
        select: {
          fullTextLinks: {
            where: { file: { projectId } },
            orderBy: { createdAt: "asc" },
            take: 1,
            select: { file: { select: { id: true, filename: true } } },
          },
        },
      },
    },
  });
  const byStudy = new Map<string, { fileId: string; filename: string }>();
  for (const link of links) {
    if (byStudy.has(link.studyId)) continue;
    const file = link.citation.fullTextLinks[0]?.file;
    if (file) byStudy.set(link.studyId, { fileId: file.id, filename: file.filename });
  }
  return byStudy;
}

export async function getExtractionMatrix(
  ctx: Ctx,
  projectId: string,
  query: z.infer<typeof matrixQuerySchema>,
): Promise<ExtractionMatrix> {
  const member = await requirePermission(ctx, projectId, "project.view");
  // The listForms blinding rule, verbatim.
  const seeAll = can(member.roles, "extraction.adjudicate") || can(member.roles, "project.edit");

  const template = await prisma.extractionTemplate.findFirst({
    where: { id: query.templateId, projectId },
    include: { fields: { orderBy: { order: "asc" } } },
  });
  if (!template) throw notFound("Extraction template");

  const [studies, forms, conflicts] = await Promise.all([
    prisma.study.findMany({
      where: { projectId },
      orderBy: { label: "asc" },
      select: { id: true, label: true, inQuantitativeSynthesis: true },
    }),
    prisma.extractionForm.findMany({
      where: {
        templateId: template.id,
        ...(seeAll ? {} : { extractorId: ctx.userId }),
      },
      include: {
        values: true,
        extractor: { select: { id: true, name: true } },
      },
      orderBy: { createdAt: "asc" },
    }),
    seeAll
      ? prisma.extractionConflict.findMany({
          where: { templateId: template.id },
          include: {
            adjudication: {
              include: { adjudicator: { select: { id: true, name: true } } },
            },
          },
        })
      : Promise.resolve([]),
  ]);
  const pdfByStudy = await resolvePdfsFor(
    projectId,
    studies.map((s) => s.id),
  );

  type ConflictRow = (typeof conflicts)[number];
  const conflictByCell = new Map<string, ConflictRow>();
  for (const conflict of conflicts) {
    conflictByCell.set(`${conflict.studyId}:${conflict.fieldId}`, conflict);
  }

  // Group entries by (study, field).
  const entriesByCell = new Map<string, MatrixEntry[]>();
  for (const form of forms) {
    for (const value of form.values) {
      const key = `${form.studyId}:${value.fieldId}`;
      const list = entriesByCell.get(key) ?? [];
      list.push({
        formId: form.id,
        extractor: form.extractor,
        formStatus: form.status as FormStatus,
        value: value.value,
        sourceQuote: value.sourceQuote,
        pageNumber: value.pageNumber,
        sourceAnchor: value.sourceAnchor,
        updatedAt: value.updatedAt,
      });
      entriesByCell.set(key, list);
    }
  }

  const fieldById = new Map(template.fields.map((f) => [f.id, f]));
  const studyRows: MatrixStudyRow[] = studies.map((study) => {
    const cells: Record<string, MatrixCell> = {};
    for (const field of template.fields) {
      const key = `${study.id}:${field.id}`;
      const entries = entriesByCell.get(key) ?? [];
      const conflict = conflictByCell.get(key);
      if (entries.length === 0 && !conflict) continue;
      const resolved = resolveMatrixCell({
        fieldType: fieldById.get(field.id)!.type,
        entries,
        conflictStatus: conflict?.status ?? null,
        adjudicatedValue:
          conflict?.status === "RESOLVED" && conflict.adjudication
            ? (conflict.adjudication.finalValue as unknown)
            : undefined,
      });
      cells[field.id] = {
        ...resolved,
        entries,
        ...(conflict?.adjudication && conflict.status === "RESOLVED"
          ? {
              adjudication: {
                finalValue: conflict.adjudication.finalValue as unknown,
                reason: conflict.adjudication.reason,
                adjudicator: conflict.adjudication.adjudicator,
              },
            }
          : {}),
      };
    }
    return {
      id: study.id,
      label: study.label,
      inQuantitativeSynthesis: study.inQuantitativeSynthesis,
      pdf: pdfByStudy.get(study.id) ?? null,
      cells,
    };
  });

  return {
    template: {
      id: template.id,
      name: template.name,
      version: template.version,
      status: template.status,
    },
    fields: template.fields.map((f) => ({
      id: f.id,
      key: f.key,
      label: f.label,
      type: f.type,
      section: f.section,
      order: f.order,
      options: fieldOptions(f.options),
    })),
    seeAll,
    studies: studyRows,
  };
}

export type { MatrixEntry, ResolvedSource } from "./matrix-resolve";
