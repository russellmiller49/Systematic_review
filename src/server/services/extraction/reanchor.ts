// Re-anchor backfill: (re)compute v2 sourceAnchors for every ExtractionValue that
// carries a sourceQuote, against the SERVER text layer (src/server/services/
// fulltext-pages). Writes touch sourceAnchor ONLY — value/sourceQuote/pageNumber are
// human-authored evidence and are never modified here.
//
// Transactions are chunked per study (a whole-project backfill must not be one giant
// tx): each study's anchor writes + their EXTRACTION_VALUE_REANCHORED audit rows commit
// together, and one EXTRACTION_REANCHOR_RUN summary row closes the run.

import { z } from "zod";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/server/db";
import { notFound } from "@/server/errors";
import type { Ctx } from "@/server/auth/session";
import { requirePermission } from "@/server/permissions";
import * as audit from "@/server/services/audit";
import { AuditActions } from "@/server/services/audit";
import { resolveStudyPdf } from "@/server/services/ai-extraction";
import { ensureFullTextPages } from "@/server/services/fulltext-pages";
import { matchQuote, normalizeForMatch, type PageText } from "@/lib/quote-match";
import { parseSourceAnchor, type SourceAnchorV2 } from "@/types/source-anchor";

export const reanchorSchema = z.object({
  templateId: z.string().min(1).optional(),
});

// Coverage report: how well the project's quoted evidence anchors into its PDFs.
// noPdf/noTextLayer count VALUES whose study lacks a resolvable PDF / usable text
// layer (NO_TEXT_LAYER or FAILED extraction); an unlocatable quote counts as pageOnly.
export interface ReanchorReport {
  total: number;
  exact: number;
  fuzzy: number;
  pageOnly: number;
  noPdf: number;
  noTextLayer: number;
}

interface TextLayer {
  pages: PageText[]; // normalized (normalizeForMatch) — matchQuote offsets index these
  textVersion: number;
}

export async function reanchorExtractionEvidence(
  ctx: Ctx,
  projectId: string,
  input: z.infer<typeof reanchorSchema>,
): Promise<ReanchorReport> {
  await requirePermission(ctx, projectId, "project.edit");
  if (input.templateId) {
    // R9: a body-supplied templateId must belong to this project.
    const template = await prisma.extractionTemplate.findFirst({
      where: { id: input.templateId, projectId },
      select: { id: true },
    });
    if (!template) throw notFound("Extraction template");
  }

  const values = await prisma.extractionValue.findMany({
    where: {
      sourceQuote: { not: null },
      form: {
        template: { projectId, ...(input.templateId ? { id: input.templateId } : {}) },
      },
    },
    include: {
      form: { select: { studyId: true } },
      field: { select: { id: true, key: true } },
    },
    orderBy: { id: "asc" },
  });

  const report: ReanchorReport = {
    total: values.length,
    exact: 0,
    fuzzy: 0,
    pageOnly: 0,
    noPdf: 0,
    noTextLayer: 0,
  };

  // Group by study (PDF resolution + tx chunking unit); cache text layers per file —
  // several studies can share one PDF object.
  type Row = (typeof values)[number];
  const byStudy = new Map<string, Row[]>();
  for (const value of values) {
    const list = byStudy.get(value.form.studyId);
    if (list) list.push(value);
    else byStudy.set(value.form.studyId, [value]);
  }
  const layerByFile = new Map<string, TextLayer | null>();

  for (const [studyId, studyValues] of byStudy) {
    const file = await resolveStudyPdf(projectId, studyId);
    if (!file) {
      report.noPdf += studyValues.length;
      continue;
    }

    let layer = layerByFile.get(file.id);
    if (layer === undefined) {
      try {
        const ensured = await ensureFullTextPages(ctx, projectId, file.id);
        layer =
          ensured.file.textStatus === "EXTRACTED"
            ? {
                pages: ensured.pages.map((p) => ({
                  page: p.page,
                  text: normalizeForMatch(p.text),
                })),
                textVersion: ensured.file.textVersion,
              }
            : null;
      } catch {
        layer = null; // FAILED extraction — the file's audit row already records why
      }
      layerByFile.set(file.id, layer);
    }
    if (layer === null) {
      report.noTextLayer += studyValues.length;
      continue;
    }
    const textLayer = layer; // const for closure narrowing

    // One transaction per study: anchors + their audit rows commit together.
    await prisma.$transaction(async (tx) => {
      for (const value of studyValues) {
        // A user selection verified against the CURRENT text layer is deliberate
        // disambiguation (the quote may repeat on the page) — never overwrite it
        // with matchQuote's first-occurrence pick.
        const existing = parseSourceAnchor(value.sourceAnchor);
        if (
          existing?.matchQuality === "selection" &&
          existing.fileId === file.id &&
          existing.textVersion === textLayer.textVersion &&
          existing.charStart !== undefined
        ) {
          report.exact += 1;
          continue;
        }
        const m = matchQuote(textLayer.pages, value.sourceQuote as string, value.pageNumber);
        let anchor: SourceAnchorV2 | null = null;
        if (m.quality === "exact" || m.quality === "fuzzy") {
          anchor = {
            v: 2,
            fileId: file.id,
            page: m.page,
            charStart: m.charStart,
            charEnd: m.charEnd,
            matchQuality: m.quality,
            matchScore: m.score,
            textVersion: textLayer.textVersion,
          };
          report[m.quality] += 1;
        } else {
          // Unlocated quote: the recorded page (or matchQuote's validated hint) still
          // anchors the evidence to a page. Without any page there is nothing to write.
          report.pageOnly += 1;
          const page = m.quality === "page-only" ? m.page : value.pageNumber;
          // Bounds-check against the extracted layer — a recorded pageNumber beyond the
          // document would mint an anchor upsertValue itself refuses to accept.
          if (page !== null && page >= 1 && page <= textLayer.pages.length) {
            anchor = {
              v: 2,
              fileId: file.id,
              page,
              matchQuality: "page-only",
              textVersion: textLayer.textVersion,
            };
          }
        }
        if (anchor === null) continue;
        await tx.extractionValue.update({
          where: { id: value.id },
          data: { sourceAnchor: anchor as unknown as Prisma.InputJsonValue },
        });
        await audit.record(tx, {
          projectId,
          userId: ctx.userId,
          entityType: "ExtractionValue",
          entityId: value.id,
          action: AuditActions.EXTRACTION_VALUE_REANCHORED,
          metadata: {
            fieldId: value.field.id,
            fieldKey: value.field.key,
            matchQuality: anchor.matchQuality,
            ...(anchor.matchScore !== undefined ? { matchScore: anchor.matchScore } : {}),
          },
        });
      }
    });
  }

  // Run summary — recorded even for empty runs (the run itself is the audited event).
  await prisma.$transaction(async (tx) => {
    await audit.record(tx, {
      projectId,
      userId: ctx.userId,
      entityType: "Project",
      entityId: projectId,
      action: AuditActions.EXTRACTION_REANCHOR_RUN,
      metadata: { ...(input.templateId ? { templateId: input.templateId } : {}), ...report },
    });
  });

  return report;
}
