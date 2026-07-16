// AI risk-of-bias suggestions — one synchronous provider call per (study, tool) reads the
// study's linked PDF and drafts, per domain: signaling answers, a judgment, and supporting
// verbatim quotes with pages.
//
// Suggestions live in RobSuggestion (docs/01 extension seam): the AI NEVER writes a
// RiskOfBiasJudgment or RiskOfBiasSignalingResponse. An assessor applies a suggestion into
// their own assessment via the rob service's applySuggestion, which re-validates judgment
// and answers and keeps the assessor as the author. Judgments that fail the tool's scale
// validation are stored with an invalidReason (visible, never applyable); domains the
// document cannot support are stored with notFound.
//
// R1 note: like extraction suggestions, RoB suggestions are keyed to (tool, study) and
// therefore shared across dual assessors — a deliberate, documented independence tradeoff.

import { z } from "zod";
import { Prisma, type AiRobRun } from "@prisma/client";
import { prisma } from "@/server/db";
import { invalidState, notFound } from "@/server/errors";
import type { Ctx } from "@/server/auth/session";
import { requirePermission } from "@/server/permissions";
import * as audit from "@/server/services/audit";
import { AuditActions } from "@/server/services/audit";
import { getStorage } from "@/server/storage";
import { getAiConfig } from "@/server/ai/config";
import { requireAiProvider } from "@/server/ai/provider";
import {
  parseRobResult,
  type ParsedRobDomain,
  type RobPromptDomain,
} from "@/server/ai/schemas";
import { buildRobPrompt, ROB_PROMPT_VERSION } from "@/server/ai/prompts/rob";
import { resolveStudyPdf } from "@/server/services/ai-extraction";
import type { JudgmentScaleEntry } from "@/server/services/rob";

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

export const runRobSuggestionSchema = z.object({
  toolId: z.string().min(1),
});

export const listRobSuggestionsQuerySchema = z.object({
  toolId: z.string().min(1),
});

// The JSON shape stored in RobSuggestion.signalingAnswers.
export interface StoredSignalingAnswer {
  questionId: string;
  answer: string;
  quote: string | null;
  page: number | null;
  invalidReason?: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function errorMessage(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 2000);
}

async function getStudyOr404(projectId: string, studyId: string) {
  const study = await prisma.study.findFirst({ where: { id: studyId, projectId } });
  if (!study) throw notFound("Study");
  return study;
}

// Read/consume-path tool load: project tool OR builtin (mirrors the rob service's
// loadVisibleTool — assessments may run directly against builtin tools).
async function getVisibleToolOr404(projectId: string, toolId: string) {
  const tool = await prisma.riskOfBiasTool.findFirst({
    where: { id: toolId, OR: [{ projectId }, { isBuiltin: true, projectId: null }] },
    include: {
      domains: {
        orderBy: { order: "asc" },
        include: { questions: { orderBy: { order: "asc" } } },
      },
    },
  });
  if (!tool) throw notFound("Risk of bias tool");
  return tool;
}

type VisibleTool = Awaited<ReturnType<typeof getVisibleToolOr404>>;

function toolScale(tool: { judgmentScale: Prisma.JsonValue }): JudgmentScaleEntry[] {
  const scale = tool.judgmentScale as unknown as JudgmentScaleEntry[];
  return Array.isArray(scale) ? scale : [];
}

function promptDomainsFor(tool: VisibleTool): RobPromptDomain[] {
  return tool.domains.map((domain) => ({
    id: domain.id,
    name: domain.name,
    guidance: domain.guidance,
    questions: domain.questions.map((q) => ({
      id: q.id,
      text: q.text,
      guidance: q.guidance,
      allowedAnswers: Array.isArray(q.allowedAnswers) ? (q.allowedAnswers as string[]) : [],
    })),
  }));
}

// Builds the stored answers JSON for one domain: keeps only this domain's question ids,
// marks answers outside the question's allowed set with an invalidReason (skipped at apply).
function storedAnswersFor(
  domain: VisibleTool["domains"][number],
  item: ParsedRobDomain | undefined,
): StoredSignalingAnswer[] {
  if (!item) return [];
  const byId = new Map(domain.questions.map((q) => [q.id, q]));
  const rows: StoredSignalingAnswer[] = [];
  for (const answer of item.answers) {
    const question = byId.get(answer.questionId);
    if (!question) continue; // another domain's (or unknown) question id
    const allowed = Array.isArray(question.allowedAnswers)
      ? (question.allowedAnswers as string[])
      : [];
    rows.push({
      questionId: answer.questionId,
      answer: answer.answer,
      quote: answer.quote,
      page: answer.page,
      ...(allowed.includes(answer.answer)
        ? {}
        : { invalidReason: `"${answer.answer}" is not an allowed answer for this question` }),
    });
  }
  return rows;
}

// ---------------------------------------------------------------------------
// Runs
// ---------------------------------------------------------------------------

export async function runRobSuggestion(
  ctx: Ctx,
  projectId: string,
  studyId: string,
  input: z.infer<typeof runRobSuggestionSchema>,
): Promise<{ run: AiRobRun; suggestions: RobSuggestionWithDomain[] }> {
  await requirePermission(ctx, projectId, "rob.assess");
  const provider = requireAiProvider();
  const config = getAiConfig();

  const study = await getStudyOr404(projectId, studyId);
  const tool = await getVisibleToolOr404(projectId, input.toolId);
  if (tool.status !== "PUBLISHED") {
    throw invalidState("AI risk-of-bias drafts require a published tool");
  }
  if (tool.domains.length === 0) {
    throw invalidState("The tool has no domains to assess");
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

  const scale = toolScale(tool);
  const prompt = buildRobPrompt({
    studyLabel: study.label,
    toolName: tool.name,
    toolDescription: tool.description,
    judgmentScale: scale.map((e) => ({ value: e.value, label: e.label })),
    domains: promptDomainsFor(tool),
  });
  // AI model: reuses the extraction model — both are PDF-in/JSON-out document reads.
  // Add a dedicated AI_ROB_MODEL env + config field if they ever need to diverge.
  const model = config.extractionModel;

  const run = await prisma.$transaction(async (tx) => {
    const created = await tx.aiRobRun.create({
      data: {
        projectId,
        studyId,
        toolId: tool.id,
        fileId: file.id,
        status: "PENDING",
        provider: provider.name,
        model,
        promptVersion: ROB_PROMPT_VERSION,
        totalDomains: tool.domains.length,
        requestedById: ctx.userId,
      },
    });
    await audit.record(tx, {
      projectId,
      userId: ctx.userId,
      entityType: "AiRobRun",
      entityId: created.id,
      action: AuditActions.AI_ROB_STARTED,
      metadata: {
        studyId,
        toolId: tool.id,
        fileId: file.id,
        totalDomains: tool.domains.length,
        provider: provider.name,
        model,
        promptVersion: ROB_PROMPT_VERSION,
      },
    });
    return created;
  });

  // Provider call + response parsing OUTSIDE any transaction (this is the slow part —
  // potentially minutes for a long PDF; runs inline on the Node server, see docs/01
  // JobRunner seam for the eventual background-worker home).
  let parsed: ParsedRobDomain[];
  let usage: { inputTokens: number; outputTokens: number } | undefined;
  try {
    const response = await provider.extractFromPdf({
      model,
      prompt,
      pdf: { bytes, filename: file.filename },
    });
    parsed = parseRobResult(response.json);
    usage = response.usage;
  } catch (error) {
    const message = errorMessage(error);
    await prisma.$transaction(async (tx) => {
      await tx.aiRobRun.update({
        where: { id: run.id },
        data: { status: "FAILED", error: message, completedAt: new Date() },
      });
      await audit.record(tx, {
        projectId,
        userId: ctx.userId,
        entityType: "AiRobRun",
        entityId: run.id,
        action: AuditActions.AI_ROB_FAILED,
        metadata: { error: message },
      });
    });
    throw invalidState(`AI risk-of-bias draft failed: ${message}`);
  }

  const scaleValues = scale.map((e) => e.value);
  const byDomain = new Map(parsed.map((item) => [item.domainId, item]));
  const updated = await prisma.$transaction(async (tx) => {
    const rows = tool.domains.map((domain) => {
      const item = byDomain.get(domain.id);
      const base = {
        runId: run.id,
        toolId: tool.id,
        studyId,
        domainId: domain.id,
        rationale: item?.rationale ?? "",
        quotes: (item?.quotes ?? []) as unknown as Prisma.InputJsonValue,
        signalingAnswers: storedAnswersFor(domain, item) as unknown as Prisma.InputJsonValue,
        confidence: item?.confidence ?? null,
        provider: run.provider,
        model: run.model,
        promptVersion: run.promptVersion,
      };
      // Missing entry, explicitly not assessable, or no judgment offered → notFound.
      if (!item || !item.assessable || item.judgment === null) {
        return { ...base, suggestedJudgment: null, notFound: true, invalidReason: null };
      }
      if (!scaleValues.includes(item.judgment)) {
        // Keep the raw judgment for transparency; invalidReason makes it non-applyable.
        return {
          ...base,
          suggestedJudgment: item.judgment,
          notFound: false,
          invalidReason: `Judgment "${item.judgment}" is not one of the tool's scale values`,
        };
      }
      return { ...base, suggestedJudgment: item.judgment, notFound: false, invalidReason: null };
    });

    // Latest-wins full replace for this (tool, study).
    await tx.robSuggestion.deleteMany({ where: { toolId: tool.id, studyId } });
    await tx.robSuggestion.createMany({ data: rows });

    const suggestedCount = rows.filter((r) => !r.notFound && r.invalidReason === null).length;
    const invalidCount = rows.filter((r) => r.invalidReason !== null).length;
    const notFoundCount = rows.filter((r) => r.notFound).length;
    const completed = await tx.aiRobRun.update({
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
      entityType: "AiRobRun",
      entityId: run.id,
      action: AuditActions.AI_ROB_COMPLETED,
      metadata: {
        totalDomains: completed.totalDomains,
        suggestedCount,
        invalidCount,
        notFoundCount,
        ...(usage ? { usage } : {}),
      },
    });
    return completed;
  });

  const suggestions = await listSuggestionRows(tool.id, studyId);
  return { run: updated, suggestions };
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

const suggestionInclude = {
  domain: { select: { id: true, name: true, order: true } },
} satisfies Prisma.RobSuggestionInclude;

export type RobSuggestionWithDomain = Prisma.RobSuggestionGetPayload<{
  include: typeof suggestionInclude;
}>;

function listSuggestionRows(toolId: string, studyId: string) {
  return prisma.robSuggestion.findMany({
    where: { toolId, studyId },
    include: suggestionInclude,
    orderBy: { domain: { order: "asc" } },
  });
}

export async function listRobSuggestions(
  ctx: Ctx,
  projectId: string,
  studyId: string,
  query: z.infer<typeof listRobSuggestionsQuerySchema>,
): Promise<{
  suggestions: RobSuggestionWithDomain[];
  latestRun: (AiRobRun & { requestedBy: { id: string; name: string } }) | null;
  pdf: { fileId: string; filename: string; sizeBytes: number } | null;
}> {
  await requirePermission(ctx, projectId, "rob.assess");
  await getStudyOr404(projectId, studyId);
  const tool = await prisma.riskOfBiasTool.findFirst({
    where: { id: query.toolId, OR: [{ projectId }, { isBuiltin: true, projectId: null }] },
    select: { id: true },
  });
  if (!tool) throw notFound("Risk of bias tool");

  const [suggestions, latestRun, file] = await Promise.all([
    listSuggestionRows(tool.id, studyId),
    prisma.aiRobRun.findFirst({
      where: { studyId, toolId: tool.id },
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
