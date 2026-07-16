// AI title/abstract prescreening — batch runs against the configured AI provider.
//
// Lifecycle (no background worker exists — docs/01): startPrescreenRun creates a PENDING
// run, submits a provider batch OUTSIDE any transaction, then marks it SUBMITTED. Progress
// is driven entirely by pollPrescreenRun (the UI auto-polls while the panel is open); on a
// terminal provider state the poll ingests results into ScreeningSuggestion rows.
//
// Suggestions live in their own table (docs/01 extension seam) — nothing here touches
// ScreeningDecision / CitationStageResult, and decision/conflict/PRISMA logic never reads
// suggestions. requestKeys preserves submission order for providers whose batch results are
// positional (gemini inline).

import { z } from "zod";
import type { AiScreeningRun, Prisma } from "@prisma/client";
import { prisma, type Tx } from "@/server/db";
import { invalidState, notFound } from "@/server/errors";
import type { Ctx } from "@/server/auth/session";
import { requirePermission } from "@/server/permissions";
import * as audit from "@/server/services/audit";
import { AuditActions } from "@/server/services/audit";
import { getAiConfig } from "@/server/ai/config";
import { requireAiProvider } from "@/server/ai/provider";
import { parseScreeningResult } from "@/server/ai/schemas";
import {
  buildScreeningPrompt,
  SCREENING_PROMPT_VERSION,
  type ScreeningProtocolContext,
} from "@/server/ai/prompts/screening";

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

export const startPrescreenSchema = z.object({
  rescoreExisting: z.boolean().optional(), // default false: only score not-yet-suggested citations
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// The run payload sent to clients. requestKeys is dropped — it can hold thousands of ids
// and exists only to map positional provider results back to citations.
export type PrescreenRunView = Omit<AiScreeningRun, "requestKeys">;

function runView(run: AiScreeningRun): PrescreenRunView {
  const { requestKeys: _requestKeys, ...view } = run;
  return view;
}

async function getStageOr404(tx: Tx, projectId: string, stageId: string) {
  const stage = await tx.screeningStage.findFirst({ where: { id: stageId, projectId } });
  if (!stage) throw notFound("Screening stage");
  return stage;
}

function eligibleCitationWhere(
  projectId: string,
  stageId: string,
  rescoreExisting: boolean,
): Prisma.CitationWhereInput {
  return {
    projectId,
    status: "ACTIVE",
    title: { not: "" },
    stageResults: { none: { stageId } }, // settled citations don't need a score
    ...(rescoreExisting ? {} : { aiSuggestions: { none: { stageId } } }),
  };
}

async function loadProtocolContext(projectId: string): Promise<ScreeningProtocolContext> {
  const protocol = await prisma.protocol.findUnique({
    where: { projectId },
    include: {
      picoQuestions: { orderBy: { order: "asc" } },
      criteria: { orderBy: { order: "asc" } },
    },
  });
  if (!protocol) {
    throw invalidState("Add a protocol before running AI prescreening");
  }
  const context: ScreeningProtocolContext = {
    reviewQuestion: protocol.reviewQuestion,
    population: protocol.population,
    intervention: protocol.intervention,
    comparator: protocol.comparator,
    outcomesNarrative: protocol.outcomesNarrative,
    studyDesigns: protocol.studyDesigns,
    setting: protocol.setting,
    dateRestrictionFrom: protocol.dateRestrictionFrom,
    dateRestrictionTo: protocol.dateRestrictionTo,
    languageRestrictions: protocol.languageRestrictions,
    picoQuestions: protocol.picoQuestions.map((q) => ({
      question: q.question,
      population: q.population,
      intervention: q.intervention,
      comparator: q.comparator,
      outcome: q.outcome,
    })),
    inclusionCriteria: protocol.criteria
      .filter((c) => c.type === "INCLUSION")
      .map((c) => ({ category: c.category, text: c.text })),
    exclusionCriteria: protocol.criteria
      .filter((c) => c.type === "EXCLUSION")
      .map((c) => ({ category: c.category, text: c.text })),
  };
  const hasAnyGuidance =
    context.inclusionCriteria.length > 0 ||
    context.exclusionCriteria.length > 0 ||
    context.picoQuestions.length > 0 ||
    Boolean(context.reviewQuestion?.trim());
  if (!hasAnyGuidance) {
    throw invalidState(
      "The protocol has no eligibility criteria, PICO questions, or review question — the AI has nothing to screen against",
    );
  }
  return context;
}

function requestKeysOf(run: AiScreeningRun): string[] {
  return Array.isArray(run.requestKeys)
    ? (run.requestKeys as unknown[]).filter((k): k is string => typeof k === "string")
    : [];
}

function errorMessage(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 2000);
}

// ---------------------------------------------------------------------------
// Runs
// ---------------------------------------------------------------------------

export async function startPrescreenRun(
  ctx: Ctx,
  projectId: string,
  stageId: string,
  input: z.infer<typeof startPrescreenSchema>,
): Promise<PrescreenRunView> {
  await requirePermission(ctx, projectId, "screening.configure");
  const provider = requireAiProvider();
  const config = getAiConfig();

  const stage = await getStageOr404(prisma, projectId, stageId);
  if (stage.type !== "TITLE_ABSTRACT") {
    throw invalidState("AI prescreening runs at the title/abstract stage");
  }
  const inFlight = await prisma.aiScreeningRun.findFirst({
    where: { stageId: stage.id, status: { in: ["PENDING", "SUBMITTED"] } },
  });
  if (inFlight) {
    throw invalidState("A prescreen run is already in progress for this stage");
  }

  const protocol = await loadProtocolContext(projectId);
  const rescoreExisting = input.rescoreExisting ?? false;
  const citations = await prisma.citation.findMany({
    where: eligibleCitationWhere(projectId, stage.id, rescoreExisting),
    select: { id: true, title: true, abstract: true, year: true, journal: true },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
  });
  if (citations.length === 0) {
    throw invalidState(
      rescoreExisting
        ? "No unsettled citations are eligible for prescreening at this stage"
        : "Every unsettled citation already has an AI score — check “re-score existing” to run them again",
    );
  }

  const items = citations.map((citation) => ({
    customId: citation.id,
    prompt: buildScreeningPrompt({
      protocol,
      citation: {
        title: citation.title,
        abstract: citation.abstract,
        year: citation.year,
        journal: citation.journal,
      },
    }),
  }));

  // tx#1: record the run before the provider call so a crash mid-submit leaves an
  // inspectable PENDING row instead of an orphaned provider batch with no trace.
  const run = await prisma.$transaction(async (tx) => {
    const created = await tx.aiScreeningRun.create({
      data: {
        projectId,
        stageId: stage.id,
        status: "PENDING",
        provider: provider.name,
        model: config.screeningModel,
        promptVersion: SCREENING_PROMPT_VERSION,
        requestKeys: citations.map((c) => c.id),
        totalCount: citations.length,
        requestedById: ctx.userId,
      },
    });
    await audit.record(tx, {
      projectId,
      userId: ctx.userId,
      entityType: "AiScreeningRun",
      entityId: created.id,
      action: AuditActions.AI_PRESCREEN_STARTED,
      metadata: {
        stageId: stage.id,
        totalCount: citations.length,
        rescoreExisting,
        provider: provider.name,
        model: config.screeningModel,
        promptVersion: SCREENING_PROMPT_VERSION,
      },
    });
    return created;
  });

  // Provider call OUTSIDE any transaction (network I/O must not hold a DB tx open).
  try {
    const { providerBatchId } = await provider.createScoringBatch({
      model: config.screeningModel,
      items,
    });
    const updated = await prisma.aiScreeningRun.update({
      where: { id: run.id },
      data: { status: "SUBMITTED", providerBatchId, submittedAt: new Date() },
    });
    return runView(updated);
  } catch (error) {
    const message = errorMessage(error);
    await prisma.$transaction(async (tx) => {
      await tx.aiScreeningRun.update({
        where: { id: run.id },
        data: { status: "FAILED", error: message, completedAt: new Date() },
      });
      await audit.record(tx, {
        projectId,
        userId: ctx.userId,
        entityType: "AiScreeningRun",
        entityId: run.id,
        action: AuditActions.AI_PRESCREEN_FAILED,
        metadata: { error: message },
      });
    });
    throw invalidState(`The AI provider rejected the batch: ${message}`);
  }
}

// Idempotent and safe under concurrent polls: the ingest transaction takes a row lock on
// the run and re-checks its status, so overlapping polls ingest exactly once.
export async function pollPrescreenRun(
  ctx: Ctx,
  projectId: string,
  runId: string,
): Promise<PrescreenRunView> {
  await requirePermission(ctx, projectId, "screening.configure");
  const run = await prisma.aiScreeningRun.findFirst({ where: { id: runId, projectId } });
  if (!run) throw notFound("Prescreen run");
  if (run.status !== "SUBMITTED" || !run.providerBatchId) return runView(run);

  const provider = requireAiProvider();
  const customIds = requestKeysOf(run);
  let snapshot;
  try {
    snapshot = await provider.getScoringBatch({
      providerBatchId: run.providerBatchId,
      customIds,
    });
  } catch (error) {
    // Transient reachability problem — leave the run SUBMITTED so the next poll retries.
    throw invalidState(`Could not reach the AI provider: ${errorMessage(error)}`);
  }
  if (snapshot.status === "processing") return runView(run);

  if (snapshot.status === "failed") {
    const failedError = snapshot.error;
    const updated = await prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "AiScreeningRun" WHERE id = ${run.id} FOR UPDATE`;
      const fresh = await tx.aiScreeningRun.findUnique({ where: { id: run.id } });
      if (!fresh || fresh.status !== "SUBMITTED") return fresh ?? run;
      const failed = await tx.aiScreeningRun.update({
        where: { id: run.id },
        data: { status: "FAILED", error: failedError.slice(0, 2000), completedAt: new Date() },
      });
      await audit.record(tx, {
        projectId,
        userId: ctx.userId,
        entityType: "AiScreeningRun",
        entityId: run.id,
        action: AuditActions.AI_PRESCREEN_FAILED,
        metadata: { error: failed.error },
      });
      return failed;
    });
    return runView(updated);
  }

  // ended → ingest results.
  const { results } = snapshot;
  const updated = await prisma.$transaction(
    async (tx) => {
      await tx.$queryRaw`SELECT id FROM "AiScreeningRun" WHERE id = ${run.id} FOR UPDATE`;
      const fresh = await tx.aiScreeningRun.findUnique({ where: { id: run.id } });
      if (!fresh || fresh.status !== "SUBMITTED") return fresh ?? run; // another poll ingested

      let inputTokens = 0;
      let outputTokens = 0;
      const parsed: {
        citationId: string;
        score: number;
        suggestedDecision: "INCLUDE" | "EXCLUDE" | "MAYBE";
        rationale: string;
      }[] = [];
      for (const result of results) {
        if (!result.ok) continue;
        if (result.usage) {
          inputTokens += result.usage.inputTokens;
          outputTokens += result.usage.outputTokens;
        }
        try {
          parsed.push({ citationId: result.customId, ...parseScreeningResult(result.json) });
        } catch {
          // Shape mismatch — counts as a failed item below.
        }
      }

      // Only citations that are still ACTIVE in this project get a suggestion (merged
      // duplicates drop out silently — their queue rows are gone anyway).
      const activeIds = new Set(
        (
          await tx.citation.findMany({
            where: { id: { in: parsed.map((p) => p.citationId) }, projectId, status: "ACTIVE" },
            select: { id: true },
          })
        ).map((c) => c.id),
      );
      const rows = parsed.filter((p) => activeIds.has(p.citationId));

      // Latest-wins upsert under @@unique([stageId, citationId]), chunked for large runs.
      const CHUNK = 200;
      for (let i = 0; i < rows.length; i += CHUNK) {
        const chunk = rows.slice(i, i + CHUNK);
        await tx.screeningSuggestion.deleteMany({
          where: { stageId: fresh.stageId, citationId: { in: chunk.map((r) => r.citationId) } },
        });
        await tx.screeningSuggestion.createMany({
          data: chunk.map((r) => ({
            stageId: fresh.stageId,
            citationId: r.citationId,
            runId: fresh.id,
            score: r.score,
            suggestedDecision: r.suggestedDecision,
            rationale: r.rationale,
            provider: fresh.provider,
            model: fresh.model,
            promptVersion: fresh.promptVersion,
          })),
        });
      }

      // failedCount is simply "requested but not scored" — provider errors, parse
      // failures, missing results, and no-longer-ACTIVE citations all land here.
      const completed = await tx.aiScreeningRun.update({
        where: { id: fresh.id },
        data: {
          status: "COMPLETED",
          succeededCount: rows.length,
          failedCount: fresh.totalCount - rows.length,
          usage: { inputTokens, outputTokens },
          completedAt: new Date(),
        },
      });
      await audit.record(tx, {
        projectId,
        userId: ctx.userId,
        entityType: "AiScreeningRun",
        entityId: fresh.id,
        action: AuditActions.AI_PRESCREEN_COMPLETED,
        metadata: {
          totalCount: completed.totalCount,
          succeededCount: completed.succeededCount,
          failedCount: completed.failedCount,
          usage: { inputTokens, outputTokens },
        },
      });
      return completed;
    },
    { timeout: 60_000, maxWait: 10_000 },
  );
  return runView(updated);
}

export async function listRuns(
  ctx: Ctx,
  projectId: string,
  stageId: string,
): Promise<{
  runs: (PrescreenRunView & { requestedBy: { id: string; name: string } })[];
  eligible: { unscored: number; unsettled: number };
}> {
  await requirePermission(ctx, projectId, "screening.configure");
  const stage = await getStageOr404(prisma, projectId, stageId);
  const [runs, unscored, unsettled] = await Promise.all([
    prisma.aiScreeningRun.findMany({
      where: { stageId: stage.id },
      orderBy: { createdAt: "desc" },
      take: 20,
      include: { requestedBy: { select: { id: true, name: true } } },
    }),
    prisma.citation.count({ where: eligibleCitationWhere(projectId, stage.id, false) }),
    prisma.citation.count({ where: eligibleCitationWhere(projectId, stage.id, true) }),
  ]);
  return {
    runs: runs.map((run) => ({ ...runView(run), requestedBy: run.requestedBy })),
    eligible: { unscored, unsettled },
  };
}

export async function getRun(
  ctx: Ctx,
  projectId: string,
  runId: string,
): Promise<PrescreenRunView> {
  await requirePermission(ctx, projectId, "screening.configure");
  const run = await prisma.aiScreeningRun.findFirst({ where: { id: runId, projectId } });
  if (!run) throw notFound("Prescreen run");
  return runView(run);
}

export async function cancelRun(
  ctx: Ctx,
  projectId: string,
  runId: string,
): Promise<PrescreenRunView> {
  await requirePermission(ctx, projectId, "screening.configure");
  const run = await prisma.aiScreeningRun.findFirst({ where: { id: runId, projectId } });
  if (!run) throw notFound("Prescreen run");
  if (run.status !== "PENDING" && run.status !== "SUBMITTED") {
    throw invalidState("Only in-flight runs can be canceled");
  }
  if (run.providerBatchId) {
    try {
      await requireAiProvider().cancelScoringBatch({ providerBatchId: run.providerBatchId });
    } catch {
      // Best-effort: the provider batch may already be terminal; the run is closed anyway.
    }
  }
  const updated = await prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM "AiScreeningRun" WHERE id = ${run.id} FOR UPDATE`;
    const fresh = await tx.aiScreeningRun.findUnique({ where: { id: run.id } });
    if (!fresh || (fresh.status !== "PENDING" && fresh.status !== "SUBMITTED")) {
      return fresh ?? run;
    }
    const canceled = await tx.aiScreeningRun.update({
      where: { id: run.id },
      data: { status: "CANCELED", completedAt: new Date() },
    });
    await audit.record(tx, {
      projectId,
      userId: ctx.userId,
      entityType: "AiScreeningRun",
      entityId: run.id,
      action: AuditActions.AI_PRESCREEN_CANCELED,
    });
    return canceled;
  });
  return runView(updated);
}
