// AI GRADE suggestions (Tier 2 prose) — one synchronous TEXT-ONLY structured call per
// outcome drafts a refined judgment + rationale per certainty domain. No document is
// attached: the prompt carries only data we already computed — the stored deterministic
// Tier-1 ratings, the pooled result, the protocol PICO, and the per-study RoB picture
// snapshotted in the RISK_OF_BIAS rating's metrics.
//
// Suggestions live in GradeDomainSuggestion: the AI NEVER writes a GradeDomainRating or
// touches the certainty arithmetic. A human applies a suggestion through the grade
// service's updateDomainRating (origin AI_APPLIED), which is the audited event —
// suggestion rows themselves are unaudited (run-level audit only, the ai-rob precedent).
//
// The deterministic tier is read from the STORED assessment ratings (including
// metrics.perStudy for RoB buckets). The grade service is consulted only for its live
// assessment fingerprint state, so a slow provider response cannot publish suggestions
// against a regenerated, edited, or otherwise out-of-date draft.

import { Prisma, type AiGradeRun, type GradeDomain, type GradeDomainSuggestion } from "@prisma/client";
import { prisma, type Tx } from "@/server/db";
import { invalidState, notFound } from "@/server/errors";
import type { Ctx } from "@/server/auth/session";
import { requirePermission } from "@/server/permissions";
import * as audit from "@/server/services/audit";
import { AuditActions } from "@/server/services/audit";
import { getAiConfig } from "@/server/ai/config";
import { requireAiProvider } from "@/server/ai/provider";
import { parseGradeResult } from "@/server/ai/schemas";
import {
  buildGradePrompt,
  GRADE_PROMPT_VERSION,
  INDIRECTNESS_UNVERIFIABLE_RATIONALE,
  type GradePromptInput,
} from "@/server/ai/prompts/grade";
import { computeOutcomeResults, type AnalysisResultRow } from "@/server/services/analysis";
import { getGradeView, gradeAssessmentVersionIsCurrent } from "@/server/services/grade";
import type { DisplayEstimate, EffectMeasureId } from "@/lib/stats/types";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const GRADE_DOMAIN_ORDER: GradeDomain[] = [
  "RISK_OF_BIAS",
  "INCONSISTENCY",
  "INDIRECTNESS",
  "IMPRECISION",
  "PUBLICATION_BIAS",
];
const TOTAL_GRADE_DOMAINS = GRADE_DOMAIN_ORDER.length;

const domainOrder = (domain: GradeDomain) => GRADE_DOMAIN_ORDER.indexOf(domain);

// Mirrors MEASURE_LABELS in src/components/analysis/types.ts (client module — not
// importable from server code).
const MEASURE_LABELS: Record<EffectMeasureId, string> = {
  RR: "Risk ratio",
  OR: "Odds ratio",
  RD: "Risk difference",
  MD: "Mean difference",
  SMD: "Std. mean difference (Hedges g)",
  PROPORTION: "Proportion (single arm)",
  GENERIC_IV: "Generic inverse variance",
};

function errorMessage(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 2000);
}

async function publicationTransaction<T>(work: (tx: Tx) => Promise<T>): Promise<T> {
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      return await prisma.$transaction(work, {
        isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead,
      });
    } catch (error) {
      const retryable =
        error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2034";
      if (!retryable || attempt === 3) throw error;
    }
  }
  throw new Error("Unreachable AI GRADE publication retry state");
}

// Per-study participant total from the resolved role values (same reading as the grade
// service's totalN rule): binary G1_TOTAL+G2_TOTAL; continuous G1_N+G2_N; proportion
// G1_TOTAL; generic effects carry no group sizes.
function studyN(measure: EffectMeasureId, values: AnalysisResultRow["values"]): number | null {
  const val = (role: string) => values[role]?.value ?? null;
  if (measure === "MD" || measure === "SMD") {
    const n1 = val("G1_N");
    const n2 = val("G2_N");
    return n1 !== null && n2 !== null ? n1 + n2 : null;
  }
  if (measure === "PROPORTION") return val("G1_TOTAL");
  if (measure === "GENERIC_IV") return null;
  const n1 = val("G1_TOTAL");
  const n2 = val("G2_TOTAL");
  return n1 !== null && n2 !== null ? n1 + n2 : null;
}

function fmtEffect(display: DisplayEstimate): string {
  const f = (x: number) => x.toFixed(2);
  return `${f(display.estimate)} [${f(display.ciLow)}, ${f(display.ciHigh)}]`;
}

// Tolerant read of the stored RISK_OF_BIAS rating's metrics.perStudy entries
// ({label, judgmentLabel, bucket, provenance, weightPct} — see src/lib/grade/rules.ts).
// Studies without an entry fall back to bucket "unassessed" at the join.
function robPerStudy(
  metrics: Prisma.JsonValue | null | undefined,
): {
  byId: Map<string, { bucket: string; judgmentLabel: string | null }>;
  byLabel: Map<string, { bucket: string; judgmentLabel: string | null }>;
} {
  const byId = new Map<string, { bucket: string; judgmentLabel: string | null }>();
  const byLabel = new Map<string, { bucket: string; judgmentLabel: string | null }>();
  if (metrics === null || metrics === undefined || typeof metrics !== "object" || Array.isArray(metrics)) {
    return { byId, byLabel };
  }
  const perStudy = (metrics as { perStudy?: unknown }).perStudy;
  if (!Array.isArray(perStudy)) return { byId, byLabel };
  for (const raw of perStudy) {
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) continue;
    const entry = raw as {
      studyId?: unknown;
      label?: unknown;
      bucket?: unknown;
      judgmentLabel?: unknown;
    };
    if (typeof entry.label !== "string") continue;
    const value = {
      bucket: typeof entry.bucket === "string" ? entry.bucket : "unassessed",
      judgmentLabel: typeof entry.judgmentLabel === "string" ? entry.judgmentLabel : null,
    };
    // New snapshots carry immutable studyId. Keep the label fallback only so drafts stored
    // before that field was added remain usable until the next deterministic regeneration.
    if (typeof entry.studyId === "string") byId.set(entry.studyId, value);
    byLabel.set(entry.label, value);
  }
  return { byId, byLabel };
}

// ---------------------------------------------------------------------------
// Runs
// ---------------------------------------------------------------------------

export async function runGradeSuggestion(
  ctx: Ctx,
  projectId: string,
  outcomeId: string,
): Promise<{ run: AiGradeRun; suggestions: GradeDomainSuggestion[] }> {
  await requirePermission(ctx, projectId, "analysis.manage");
  const provider = requireAiProvider();
  const config = getAiConfig();

  // R9: by-id load is project-scoped; miss -> 404.
  const outcomeExists = await prisma.analysisOutcome.findFirst({
    where: { id: outcomeId, projectId },
    select: { id: true },
  });
  if (!outcomeExists) throw notFound("Analysis outcome");

  const gradeView = await getGradeView(ctx, projectId, outcomeId);
  const assessment = gradeView.assessment;
  if (!assessment) throw invalidState("Generate the deterministic GRADE draft first");
  if (!gradeView.canDraft) {
    throw invalidState(
      "No pooled result for this outcome — the AI draft needs at least one pooled study",
    );
  }
  if (gradeView.outOfDate) {
    throw invalidState(
      "The evidence or protocol context changed — regenerate GRADE before requesting AI suggestions",
    );
  }
  const assessmentVersion = {
    id: assessment.id,
    updatedAt: assessment.updatedAt,
  };

  // Caller-independent final-only resolution: provisional extraction data can never reach
  // the shared AI prompt, even when an owner/admin starts the run.
  const results = await computeOutcomeResults(ctx, projectId, outcomeId, { finalOnly: true });
  const outcome = results.outcome;
  const measure = outcome.measure as EffectMeasureId;
  const pooledRows = results.rows.filter((row) => row.effect !== null);
  const pooled = outcome.model === "FIXED" ? results.pooled.fixed : results.pooled.random;
  if (pooledRows.length === 0 || pooled === null) {
    throw invalidState(
      "No pooled result for this outcome — the AI draft needs at least one pooled study",
    );
  }

  const perStudyNs = pooledRows.map((row) => studyN(measure, row.values));
  const totalN = perStudyNs.every((n): n is number => n !== null)
    ? perStudyNs.reduce((sum, n) => sum + n, 0)
    : null;

  const robRating = assessment.ratings.find((r) => r.domain === "RISK_OF_BIAS");
  const robByStudy = robPerStudy(robRating?.metrics);

  const protocol = await prisma.protocol.findUnique({
    where: { projectId },
    include: { picoQuestions: { orderBy: [{ order: "asc" }, { id: "asc" }] } },
  });
  // The protocol has no title/description fields — reviewQuestion + background are the
  // closest summary prose.
  const summaryParts = [protocol?.reviewQuestion?.trim(), protocol?.background?.trim()].filter(
    (part): part is string => Boolean(part),
  );

  const promptInput: GradePromptInput = {
    outcome: {
      name: outcome.name,
      timepoint: outcome.timepoint,
      measure: outcome.measure,
      direction: outcome.direction,
      groupLabels: results.groupLabels,
    },
    picos: (protocol?.picoQuestions ?? []).map((pico) => ({
      question: pico.question,
      population: pico.population,
      intervention: pico.intervention,
      comparator: pico.comparator,
      outcomes: pico.outcome,
    })),
    protocolSummary: summaryParts.length > 0 ? summaryParts.join("\n") : null,
    deterministic: [...assessment.ratings]
      .sort((a, b) => domainOrder(a.domain) - domainOrder(b.domain))
      .map((rating) => ({
        domain: rating.domain,
        judgment: rating.judgment,
        rationale: rating.rationale,
        requiresReview: rating.requiresReview,
        metrics: rating.metrics,
      })),
    pooledSummary: {
      k: pooledRows.length,
      totalN,
      estimate: pooled.display.estimate,
      ciLow: pooled.display.ciLow,
      ciHigh: pooled.display.ciHigh,
      i2: results.heterogeneity?.i2 ?? null,
      model: outcome.model,
      measureLabel: MEASURE_LABELS[measure],
    },
    studies: pooledRows.map((row, i) => {
      const rob = robByStudy.byId.get(row.studyId) ?? robByStudy.byLabel.get(row.label);
      return {
        label: row.label,
        n: perStudyNs[i] ?? null,
        effectDisplay: row.effect ? fmtEffect(row.effect.display) : null,
        robBucket: rob?.bucket ?? "unassessed",
        robJudgmentLabel: rob?.judgmentLabel ?? null,
      };
    }),
  };
  const prompt = buildGradePrompt(promptInput);
  // AI model: reuses the extraction model — both are long-context structured JSON calls.
  // Add a dedicated AI_GRADE_MODEL env + config field if they ever need to diverge.
  const model = config.extractionModel;

  const run = await prisma.$transaction(async (tx) => {
    const created = await tx.aiGradeRun.create({
      data: {
        projectId,
        analysisOutcomeId: outcome.id,
        status: "PENDING",
        provider: provider.name,
        model,
        promptVersion: GRADE_PROMPT_VERSION,
        totalDomains: TOTAL_GRADE_DOMAINS,
        requestedById: ctx.userId,
      },
    });
    await audit.record(tx, {
      projectId,
      userId: ctx.userId,
      entityType: "AiGradeRun",
      entityId: created.id,
      action: AuditActions.AI_GRADE_STARTED,
      metadata: {
        analysisOutcomeId: outcome.id,
        totalDomains: TOTAL_GRADE_DOMAINS,
        provider: provider.name,
        model,
        promptVersion: GRADE_PROMPT_VERSION,
      },
    });
    return created;
  });

  // Provider call + response parsing OUTSIDE any transaction (the slow part — runs
  // inline on the Node server; see the docs/01 JobRunner seam for the eventual home).
  let parsed: ReturnType<typeof parseGradeResult>;
  let usage: { inputTokens: number; outputTokens: number } | undefined;
  try {
    const response = await provider.completeStructured({ model, prompt });
    parsed = parseGradeResult(response.json);
    usage = response.usage;
  } catch (error) {
    const message = errorMessage(error);
    await prisma.$transaction(async (tx) => {
      await tx.aiGradeRun.update({
        where: { id: run.id },
        data: { status: "FAILED", error: message, completedAt: new Date() },
      });
      await audit.record(tx, {
        projectId,
        userId: ctx.userId,
        entityType: "AiGradeRun",
        entityId: run.id,
        action: AuditActions.AI_GRADE_FAILED,
        metadata: { error: message },
      });
    });
    throw invalidState(`AI GRADE draft failed: ${message}`);
  }

  // The model never receives study-level P/I/C/O characteristics, so it cannot ground an
  // indirectness conclusion. Enforce the safe placeholder server-side even if a provider
  // ignores the prompt and claims a match or downgrade.
  parsed = {
    ...parsed,
    domains: parsed.domains.map((domain) =>
      domain.domain === "INDIRECTNESS"
        ? {
            ...domain,
            judgment: "NOT_SERIOUS" as const,
            rationale: INDIRECTNESS_UNVERIFIABLE_RATIONALE,
            confidence: null,
          }
        : domain,
    ),
  };

  // Recheck after the slow provider call. This closes the ordinary edit/regeneration and
  // source-change races; the transactional version check below closes the remaining gap
  // between this read and publication for assessment mutations.
  const currentGradeView = await getGradeView(ctx, projectId, outcomeId);
  const currentAssessment = currentGradeView.assessment;
  const assessmentStillCurrent =
    currentAssessment !== null &&
    currentAssessment.id === assessmentVersion.id &&
    currentAssessment.updatedAt.getTime() === assessmentVersion.updatedAt.getTime() &&
    !currentGradeView.outOfDate;

  const publication = await publicationTransaction(async (tx) => {
    // Serialize publishers for an outcome. A newer COMPLETED run wins regardless of which
    // provider request finishes last; failed/pending newer attempts do not erase the most
    // recent successful suggestions (the same behavior as sequential retries).
    const locked = await tx.$queryRaw<{ id: string }[]>`
      SELECT "id"
      FROM "AnalysisOutcome"
      WHERE "id" = ${outcome.id} AND "projectId" = ${projectId}
      FOR UPDATE
    `;
    if (locked.length === 0) throw notFound("Analysis outcome");
    const newerCompleted = await tx.aiGradeRun.findFirst({
      where: {
        analysisOutcomeId: outcome.id,
        status: "COMPLETED",
        OR: [
          { createdAt: { gt: run.createdAt } },
          { createdAt: run.createdAt, id: { gt: run.id } },
        ],
      },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      select: { id: true },
    });
    const assessmentVersionMatches =
      assessmentStillCurrent &&
      (await gradeAssessmentVersionIsCurrent(
        ctx,
        projectId,
        outcome.id,
        assessmentVersion,
        tx,
      ));
    const published = newerCompleted === null && assessmentVersionMatches;
    if (published) {
      await tx.gradeDomainSuggestion.deleteMany({ where: { analysisOutcomeId: outcome.id } });
      await tx.gradeDomainSuggestion.createMany({
        data: parsed.domains.map((item) => ({
          runId: run.id,
          analysisOutcomeId: outcome.id,
          domain: item.domain,
          suggestedJudgment: item.judgment,
          rationale: item.rationale,
          confidence: item.confidence,
          provider: run.provider,
          model: run.model,
          promptVersion: run.promptVersion,
        })),
      });
    }
    const completed = await tx.aiGradeRun.update({
      where: { id: run.id },
      data: {
        status: "COMPLETED",
        suggestedCount: published ? parsed.domains.length : 0,
        invalidCount: parsed.invalidCount,
        usage: usage ?? Prisma.DbNull,
        completedAt: new Date(),
      },
    });
    await audit.record(tx, {
      projectId,
      userId: ctx.userId,
      entityType: "AiGradeRun",
      entityId: run.id,
      action: AuditActions.AI_GRADE_COMPLETED,
      metadata: {
        totalDomains: completed.totalDomains,
        suggestedCount: completed.suggestedCount,
        invalidCount: parsed.invalidCount,
        superseded: !published,
        supersededReason:
          newerCompleted !== null
            ? "newer_completed_run"
            : !assessmentVersionMatches
              ? "assessment_or_source_changed"
              : null,
        ...(usage ? { usage } : {}),
      },
    });
    return { run: completed, published };
  });

  const suggestions = publication.published
    ? await prisma.gradeDomainSuggestion.findMany({ where: { runId: run.id } })
    : [];
  suggestions.sort((a, b) => domainOrder(a.domain) - domainOrder(b.domain));
  return { run: publication.run, suggestions };
}
