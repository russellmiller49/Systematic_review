// AI full-text extraction suggestions — one synchronous provider call per (study, template)
// reads the study's linked PDF and drafts a value for every template field.
//
// Suggestions live in ExtractionSuggestion (docs/01 extension seam): the AI NEVER writes an
// ExtractionValue. A human applies a suggestion into their own form via the existing
// upsertValue path (appliedSuggestionId), which re-validates the value and keeps the
// extractor as the author. Values that fail validateFieldValue are stored with an
// invalidReason (visible, never applyable); fields the document doesn't report are stored
// with notFound.

import { z } from "zod";
import { Prisma, type AiExtractionRun, type FullTextFile } from "@prisma/client";
import { prisma } from "@/server/db";
import { AppError, invalidState, notFound } from "@/server/errors";
import type { Ctx } from "@/server/auth/session";
import { requirePermission } from "@/server/permissions";
import * as audit from "@/server/services/audit";
import { AuditActions } from "@/server/services/audit";
import { getStorage } from "@/server/storage";
import { getAiConfig } from "@/server/ai/config";
import { requireAiProvider } from "@/server/ai/provider";
import {
  parseExtractionResult,
  type ParsedExtractionField,
  type PromptField,
} from "@/server/ai/schemas";
import {
  buildExtractionPrompt,
  EXTRACTION_PROMPT_VERSION,
} from "@/server/ai/prompts/extraction";
import { fieldOptions, validateFieldValue } from "@/server/services/extraction/validation";

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

export const runSuggestionSchema = z.object({
  templateId: z.string().min(1),
});

export const listSuggestionsQuerySchema = z.object({
  templateId: z.string().min(1),
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function errorMessage(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 2000);
}

// Study → PDF: primary report first, then other reports; per citation the oldest linked
// file wins (mirrors how the Extract tab picks the primary citation).
export async function resolveStudyPdf(
  projectId: string,
  studyId: string,
): Promise<FullTextFile | null> {
  const links = await prisma.studyReportLink.findMany({
    where: { studyId },
    orderBy: [{ isPrimaryReport: "desc" }, { id: "asc" }],
    select: { citationId: true },
  });
  for (const link of links) {
    const fileLink = await prisma.citationFullTextLink.findFirst({
      where: { citationId: link.citationId, file: { projectId } },
      orderBy: { createdAt: "asc" },
      include: { file: true },
    });
    if (fileLink) return fileLink.file;
  }
  return null;
}

async function getStudyOr404(projectId: string, studyId: string) {
  const study = await prisma.study.findFirst({ where: { id: studyId, projectId } });
  if (!study) throw notFound("Study");
  return study;
}

// ---------------------------------------------------------------------------
// Runs
// ---------------------------------------------------------------------------

export async function runExtractionSuggestion(
  ctx: Ctx,
  projectId: string,
  studyId: string,
  input: z.infer<typeof runSuggestionSchema>,
): Promise<{ run: AiExtractionRun; suggestions: SuggestionWithField[] }> {
  await requirePermission(ctx, projectId, "extraction.perform");
  const provider = requireAiProvider();
  const config = getAiConfig();

  const study = await getStudyOr404(projectId, studyId);
  const template = await prisma.extractionTemplate.findFirst({
    where: { id: input.templateId, projectId },
    include: { fields: { orderBy: { order: "asc" } } },
  });
  if (!template) throw notFound("Extraction template");
  if (template.status !== "PUBLISHED") {
    throw invalidState("AI extraction requires a published template");
  }
  if (template.fields.length === 0) {
    throw invalidState("The template has no fields to extract");
  }

  const file = await resolveStudyPdf(projectId, studyId);
  if (!file) {
    throw invalidState(
      "No PDF is linked to this study's reports — upload one on the Full text page first",
    );
  }
  if (file.sizeBytes > provider.maxPdfBytes) {
    const mb = (n: number) => (n / (1024 * 1024)).toFixed(1);
    throw invalidState(
      `This PDF is ${mb(file.sizeBytes)}MB — the ${provider.name} provider supports up to ${mb(provider.maxPdfBytes)}MB`,
    );
  }
  let bytes: Buffer;
  try {
    bytes = await getStorage().get(file.storageKey);
  } catch {
    throw notFound("Stored PDF");
  }

  const promptFields: PromptField[] = template.fields.map((field) => ({
    id: field.id,
    key: field.key,
    label: field.label,
    type: field.type,
    required: field.required,
    section: field.section,
    helpText: field.helpText,
    options: fieldOptions(field.options),
  }));
  const prompt = buildExtractionPrompt({ studyLabel: study.label, fields: promptFields });

  const run = await prisma.$transaction(async (tx) => {
    const created = await tx.aiExtractionRun.create({
      data: {
        projectId,
        studyId,
        templateId: template.id,
        fileId: file.id,
        status: "PENDING",
        provider: provider.name,
        model: config.extractionModel,
        promptVersion: EXTRACTION_PROMPT_VERSION,
        totalFields: template.fields.length,
        requestedById: ctx.userId,
      },
    });
    await audit.record(tx, {
      projectId,
      userId: ctx.userId,
      entityType: "AiExtractionRun",
      entityId: created.id,
      action: AuditActions.AI_EXTRACTION_STARTED,
      metadata: {
        studyId,
        templateId: template.id,
        fileId: file.id,
        totalFields: template.fields.length,
        provider: provider.name,
        model: config.extractionModel,
        promptVersion: EXTRACTION_PROMPT_VERSION,
      },
    });
    return created;
  });

  // Provider call + response parsing OUTSIDE any transaction (this is the slow part —
  // potentially minutes for a long PDF; runs inline on the Node server, see docs/01
  // JobRunner seam for the eventual background-worker home).
  let parsed: ParsedExtractionField[];
  let usage: { inputTokens: number; outputTokens: number } | undefined;
  try {
    const response = await provider.extractFromPdf({
      model: config.extractionModel,
      prompt,
      pdf: { bytes, filename: file.filename },
    });
    parsed = parseExtractionResult(response.json);
    usage = response.usage;
  } catch (error) {
    const message = errorMessage(error);
    await prisma.$transaction(async (tx) => {
      await tx.aiExtractionRun.update({
        where: { id: run.id },
        data: { status: "FAILED", error: message, completedAt: new Date() },
      });
      await audit.record(tx, {
        projectId,
        userId: ctx.userId,
        entityType: "AiExtractionRun",
        entityId: run.id,
        action: AuditActions.AI_EXTRACTION_FAILED,
        metadata: { error: message },
      });
    });
    throw invalidState(`AI extraction failed: ${message}`);
  }

  const byKey = new Map(parsed.map((item) => [item.key, item]));
  const updated = await prisma.$transaction(async (tx) => {
    const rows = template.fields.map((field) => {
      const item = byKey.get(field.key);
      const base = {
        runId: run.id,
        templateId: template.id,
        studyId,
        fieldId: field.id,
        sourceQuote: item?.sourceQuote ?? null,
        pageNumber: item?.pageNumber ?? null,
        sourceAnchor: { fileId: file.id, page: item?.pageNumber ?? null },
        confidence: item?.confidence ?? null,
        provider: run.provider,
        model: run.model,
        promptVersion: run.promptVersion,
      };
      if (!item || !item.found) {
        return { ...base, value: Prisma.DbNull, notFound: true, invalidReason: null };
      }
      try {
        const value = validateFieldValue(field, item.value) as Prisma.InputJsonValue;
        return { ...base, value, notFound: false, invalidReason: null };
      } catch (error) {
        // Keep the raw value for transparency; invalidReason makes it non-applyable.
        return {
          ...base,
          value:
            item.value === null || item.value === undefined
              ? Prisma.DbNull
              : (item.value as Prisma.InputJsonValue),
          notFound: false,
          invalidReason:
            error instanceof AppError ? error.message : "Value failed validation",
        };
      }
    });

    // Latest-wins full replace for this (template, study).
    await tx.extractionSuggestion.deleteMany({
      where: { templateId: template.id, studyId },
    });
    await tx.extractionSuggestion.createMany({ data: rows });

    const suggestedCount = rows.filter((r) => !r.notFound && r.invalidReason === null).length;
    const invalidCount = rows.filter((r) => r.invalidReason !== null).length;
    const notFoundCount = rows.filter((r) => r.notFound).length;
    const completed = await tx.aiExtractionRun.update({
      where: { id: run.id },
      data: {
        status: "COMPLETED",
        suggestedCount,
        invalidCount,
        notFoundCount,
        usage: usage ?? Prisma.DbNull,
        completedAt: new Date(),
      },
    });
    await audit.record(tx, {
      projectId,
      userId: ctx.userId,
      entityType: "AiExtractionRun",
      entityId: run.id,
      action: AuditActions.AI_EXTRACTION_COMPLETED,
      metadata: {
        totalFields: completed.totalFields,
        suggestedCount,
        invalidCount,
        notFoundCount,
        ...(usage ? { usage } : {}),
      },
    });
    return completed;
  });

  const suggestions = await listSuggestionRows(template.id, studyId);
  return { run: updated, suggestions };
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

const suggestionInclude = {
  field: { select: { id: true, key: true, label: true, type: true, order: true } },
} satisfies Prisma.ExtractionSuggestionInclude;

export type SuggestionWithField = Prisma.ExtractionSuggestionGetPayload<{
  include: typeof suggestionInclude;
}>;

function listSuggestionRows(templateId: string, studyId: string) {
  return prisma.extractionSuggestion.findMany({
    where: { templateId, studyId },
    include: suggestionInclude,
    orderBy: { field: { order: "asc" } },
  });
}

export async function listSuggestions(
  ctx: Ctx,
  projectId: string,
  studyId: string,
  query: z.infer<typeof listSuggestionsQuerySchema>,
): Promise<{
  suggestions: SuggestionWithField[];
  latestRun:
    | (AiExtractionRun & { requestedBy: { id: string; name: string } })
    | null;
  pdf: { fileId: string; filename: string; sizeBytes: number } | null;
}> {
  await requirePermission(ctx, projectId, "extraction.perform");
  await getStudyOr404(projectId, studyId);
  const template = await prisma.extractionTemplate.findFirst({
    where: { id: query.templateId, projectId },
    select: { id: true },
  });
  if (!template) throw notFound("Extraction template");

  const [suggestions, latestRun, file] = await Promise.all([
    listSuggestionRows(template.id, studyId),
    prisma.aiExtractionRun.findFirst({
      where: { studyId, templateId: template.id },
      orderBy: { createdAt: "desc" },
      include: { requestedBy: { select: { id: true, name: true } } },
    }),
    resolveStudyPdf(projectId, studyId),
  ]);
  return {
    suggestions,
    latestRun,
    pdf: file ? { fileId: file.id, filename: file.filename, sizeBytes: file.sizeBytes } : null,
  };
}
