// GRADE domain service — deterministic certainty-of-evidence drafts over pooled analysis
// results, human/AI-applied rating edits, review lifecycle, and the Summary of Findings.
//
// Contract highlights:
//   - Tier 1 is PURE RULES (src/lib/grade) over computeOutcomeResults — no AI in any
//     computation. AI participates only via GradeDomainSuggestion rows a human applies
//     through updateDomainRating.
//   - R1: results use the analysis service's caller-independent final-only mode, and the
//     RoB roll-up independently withholds provisional judgments. Stored/shared GRADE
//     metrics therefore never depend on who generated them or carry pre-consensus data.
//   - R9: the outcome is loaded tenant-scoped (404 on miss); suggestions are validated
//     against the outcome before applying.
//   - Permissions reuse analysis.view (read) / analysis.manage (mutate) — no new
//     capabilities. Certainty is recomputed in the SAME tx as every rating/starting-level
//     change; any change flips a REVIEWED assessment back to DRAFT.

import { z } from "zod";
import { createHash } from "node:crypto";
import {
  Prisma,
  type AiGradeRun,
  type GradeAssessmentStatus,
  type GradeCertainty,
  type GradeDomainRating,
  type GradeDomainSuggestion,
  type GradeRatingOrigin,
  type GradeStartingLevel,
} from "@prisma/client";
import { prisma, type Tx } from "@/server/db";
import { invalidState, notFound, validationError } from "@/server/errors";
import type { Ctx } from "@/server/auth/session";
import { requirePermission } from "@/server/permissions";
import * as audit from "@/server/services/audit";
import { AuditActions } from "@/server/services/audit";
import {
  computeOutcomeResults,
  type AnalysisResultRow,
  type AnalysisResults,
} from "@/server/services/analysis";
import { computeCertainty, draftGradeRatings } from "@/lib/grade/rules";
import {
  absoluteFromRelative,
  medianControlRiskPer1000,
  type AbsoluteEffect,
} from "@/lib/grade/absolute";
import type {
  GradeCertaintyId,
  GradeDomainId,
  GradeJudgmentId,
  GradeRulesInput,
  GradeStudyInput,
} from "@/lib/grade/types";
import { resolveRobForStudies } from "./rob-rollup";

export { resolveRobForStudies } from "./rob-rollup";

// ---------------------------------------------------------------------------
// Schemas + domain param
// ---------------------------------------------------------------------------

export const GRADE_DOMAIN_ORDER: readonly GradeDomainId[] = [
  "RISK_OF_BIAS",
  "INCONSISTENCY",
  "INDIRECTNESS",
  "IMPRECISION",
  "PUBLICATION_BIAS",
];

/** Uppercase + validate a [domain] path param; unknown values are a 400. */
export function parseGradeDomainParam(raw: string): GradeDomainId {
  const upper = raw.toUpperCase();
  if ((GRADE_DOMAIN_ORDER as readonly string[]).includes(upper)) return upper as GradeDomainId;
  throw validationError(`Unknown GRADE domain "${raw}"`, { allowed: GRADE_DOMAIN_ORDER });
}

export const generateDraftSchema = z.object({
  startingLevel: z.enum(["HIGH", "LOW"]).optional(),
});

export const updateRatingSchema = z
  .object({
    judgment: z.enum(["NOT_SERIOUS", "SERIOUS", "VERY_SERIOUS"]).optional(),
    rationale: z.string().trim().min(1).max(8000).optional(),
    appliedSuggestionId: z.string().min(1).optional(),
  })
  .refine(
    (v) =>
      v.judgment !== undefined || v.rationale !== undefined || v.appliedSuggestionId !== undefined,
    { message: "Provide a judgment, a rationale, or a suggestion to apply" },
  )
  .refine(
    (v) => v.appliedSuggestionId === undefined || (v.judgment === undefined && v.rationale === undefined),
    {
      message: "appliedSuggestionId cannot be combined with judgment or rationale",
      path: ["appliedSuggestionId"],
    },
  );

export const setStartingLevelSchema = z.object({
  startingLevel: z.enum(["HIGH", "LOW"]),
});

// ---------------------------------------------------------------------------
// Payload shapes (mirrored into src/components/analysis/types.ts by the UI)
// ---------------------------------------------------------------------------

export interface GradeAssessmentPayload {
  id: string;
  analysisOutcomeId: string;
  status: GradeAssessmentStatus;
  startingLevel: GradeStartingLevel;
  certainty: GradeCertainty;
  points: number; // recomputed via computeCertainty for display math
  generatedAt: Date;
  reviewedAt: Date | null;
  reviewedBy: { id: string; name: string } | null;
  createdById: string;
  createdAt: Date;
  updatedAt: Date;
  ratings: GradeDomainRating[]; // canonical domain order
}

export type GradeRunPayload = AiGradeRun & { requestedBy: { id: string; name: string } };

export interface GradeView {
  assessment: GradeAssessmentPayload | null;
  canDraft: boolean; // live pooled k >= 1
  staleDomains: GradeDomainId[]; // AUTO ratings whose live metrics differ from stored
  sourceUnavailable: boolean; // a stored assessment exists, but no study currently pools
  outOfDate: boolean; // assessment-level statistics/RoB/outcome/protocol fingerprint changed
  suggestions: GradeDomainSuggestion[]; // canonical domain order
  latestRun: GradeRunPayload | null;
}

const ASSESSMENT_INCLUDE = {
  ratings: true,
  reviewedBy: { select: { id: true, name: true } },
} satisfies Prisma.GradeAssessmentInclude;

export type AssessmentWithRatings = Prisma.GradeAssessmentGetPayload<{
  include: typeof ASSESSMENT_INCLUDE;
}>;

function orderRatings(ratings: GradeDomainRating[]): GradeDomainRating[] {
  return GRADE_DOMAIN_ORDER.flatMap((domain) => ratings.filter((r) => r.domain === domain));
}

function toAssessmentPayload(row: AssessmentWithRatings): GradeAssessmentPayload {
  const ratings = orderRatings(row.ratings);
  const { points } = computeCertainty(
    row.startingLevel,
    ratings.map((r) => r.judgment as GradeJudgmentId),
  );
  return {
    id: row.id,
    analysisOutcomeId: row.analysisOutcomeId,
    status: row.status,
    startingLevel: row.startingLevel,
    certainty: row.certainty,
    points,
    generatedAt: row.generatedAt,
    reviewedAt: row.reviewedAt,
    reviewedBy: row.reviewedBy,
    createdById: row.createdById,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    ratings,
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// R9: by-id load is project-scoped; miss -> 404.
async function loadOutcome(db: Tx, projectId: string, outcomeId: string) {
  const outcome = await db.analysisOutcome.findFirst({ where: { id: outcomeId, projectId } });
  if (!outcome) throw notFound("Analysis outcome");
  return outcome;
}

// Every mutation for one assessment locks the always-present parent outcome first. Locking
// GradeAssessment itself would not serialize two concurrent first-time draft generations,
// because that row does not exist yet. The shared parent lock covers creation as well as
// rating/starting-level/review changes and gives every mutation the same lock order.
async function lockOutcomeForGradeMutation(db: Tx, projectId: string, outcomeId: string) {
  const locked = await db.$queryRaw<{ id: string }[]>`
    SELECT "id"
    FROM "AnalysisOutcome"
    WHERE "id" = ${outcomeId} AND "projectId" = ${projectId}
    FOR UPDATE
  `;
  if (locked.length === 0) throw notFound("Analysis outcome");
}

// A concurrent writer can make a repeatable-read snapshot stale while this transaction
// waits on the parent row lock. PostgreSQL reports that as Prisma P2034; retrying from a
// fresh snapshot preserves the parent-first serialization contract and the winning edit.
async function gradeWriteTransaction<T>(work: (tx: Tx) => Promise<T>): Promise<T> {
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
  throw new Error("Unreachable GRADE transaction retry state");
}

// Per-study participant count from the resolved role values (measure-aware); null when
// the measure carries no counts (GENERIC_IV) or a needed value is missing.
function studyN(
  measure: AnalysisResults["outcome"]["measure"],
  values: AnalysisResultRow["values"],
): number | null {
  const v = (role: string) => values[role]?.value ?? null;
  switch (measure) {
    case "RR":
    case "OR":
    case "RD": {
      const a = v("G1_TOTAL");
      const b = v("G2_TOTAL");
      return a !== null && b !== null ? a + b : null;
    }
    case "MD":
    case "SMD": {
      const a = v("G1_N");
      const b = v("G2_N");
      return a !== null && b !== null ? a + b : null;
    }
    case "PROPORTION":
      return v("G1_TOTAL");
    case "GENERIC_IV":
      return null;
  }
}

// Sum of per-study n across pooled rows; null when ANY pooled study's n is unknown.
function sumStudyN(
  measure: AnalysisResults["outcome"]["measure"],
  rows: AnalysisResultRow[],
): number | null {
  let total = 0;
  for (const row of rows) {
    const n = studyN(measure, row.values);
    if (n === null) return null;
    total += n;
  }
  return rows.length > 0 ? total : null;
}

interface DraftInputs {
  results: AnalysisResults;
  pooledRows: AnalysisResultRow[];
  rulesInput: GradeRulesInput | null; // null when nothing pools (k = 0)
  sourceFingerprint: string | null;
}

async function gradeApplicabilityContext(db: Tx, projectId: string, results: AnalysisResults) {
  const protocol = await db.protocol.findUnique({
    where: { projectId },
    select: {
      reviewQuestion: true,
      background: true,
      population: true,
      intervention: true,
      comparator: true,
      outcomesNarrative: true,
      studyDesigns: true,
      setting: true,
      gradePlan: true,
      picoQuestions: {
        orderBy: [{ order: "asc" }, { id: "asc" }],
        select: {
          id: true,
          order: true,
          question: true,
          population: true,
          intervention: true,
          comparator: true,
          outcome: true,
        },
      },
      outcomes: {
        where: results.outcome.outcomeDefinitionId
          ? { id: results.outcome.outcomeDefinitionId }
          : { id: { in: [] } },
        orderBy: [{ order: "asc" }, { id: "asc" }],
        select: {
          id: true,
          order: true,
          name: true,
          type: true,
          measure: true,
          timepoint: true,
        },
      },
      criteria: {
        orderBy: [{ type: "asc" }, { order: "asc" }, { id: "asc" }],
        select: { id: true, type: true, category: true, text: true, order: true },
      },
    },
  });
  return {
    outcome: {
      name: results.outcome.name,
      timepoint: results.outcome.timepoint,
      measure: results.outcome.measure,
      direction: results.outcome.direction,
      model: results.outcome.model,
      proportionTransform: results.outcome.proportionTransform,
      groupLabels: results.groupLabels,
      outcomeDefinitionId: results.outcome.outcomeDefinitionId,
      mappings: [...results.outcome.mappings].sort(
        (a, b) =>
          a.role.localeCompare(b.role) ||
          a.templateId.localeCompare(b.templateId) ||
          a.fieldKey.localeCompare(b.fieldKey),
      ),
    },
    protocol,
  };
}

function sourceFingerprintFor(
  rulesInput: GradeRulesInput,
  applicabilityContext: Awaited<ReturnType<typeof gradeApplicabilityContext>>,
  pooledRows: AnalysisResultRow[],
): string {
  const sourceRatings = draftGradeRatings(rulesInput).ratings.map((rating) => ({
    domain: rating.domain,
    judgment: rating.judgment,
    rationale: rating.rationale,
    requiresReview: rating.requiresReview,
    metrics: rating.metrics,
  }));
  const studyById = new Map(rulesInput.studies.map((study) => [study.studyId, study]));
  const aiStudyEvidence = pooledRows
    .map((row) => ({
      studyId: row.studyId,
      label: row.label,
      n: studyById.get(row.studyId)?.n ?? null,
      effectDisplay: row.effect
        ? `${row.effect.display.estimate.toFixed(2)} [${row.effect.display.ciLow.toFixed(2)}, ${row.effect.display.ciHigh.toFixed(2)}]`
        : null,
      rob: studyById.get(row.studyId)?.rob ?? null,
    }))
    .sort((a, b) => a.studyId.localeCompare(b.studyId));
  return createHash("sha256")
    .update(
      stableStringify({
        version: 2,
        applicabilityContext,
        sourceRatings,
        aiStudyEvidence,
      }),
    )
    .digest("hex");
}

// The one code path both generateDraft and the staleness check use. GRADE rows are shared,
// so analysis resolution is caller-independent and final-only: a SINGLE extraction is
// withheld while any co-extraction work remains open, even for owners/admins.
async function buildDraftInputs(
  ctx: Ctx,
  projectId: string,
  outcomeId: string,
  startingLevel: GradeStartingLevel,
  db: Tx = prisma,
  precomputedResults?: AnalysisResults,
): Promise<DraftInputs> {
  const results =
    precomputedResults ??
    (await computeOutcomeResults(ctx, projectId, outcomeId, { finalOnly: true }, db));
  const pooledRows = results.rows.filter((r) => r.effect !== null);
  const k = pooledRows.length;
  const model = results.outcome.model;
  const pooled = model === "FIXED" ? results.pooled.fixed : results.pooled.random;
  if (k === 0 || pooled === null) {
    return { results, pooledRows, rulesInput: null, sourceFingerprint: null };
  }

  const measure = results.outcome.measure;
  const rob = await resolveRobForStudies(
    db,
    projectId,
    pooledRows.map((r) => r.studyId),
  );
  const studies: GradeStudyInput[] = pooledRows.map((row) => {
    const effect = row.effect!;
    return {
      studyId: row.studyId,
      label: row.label,
      weightPct: model === "FIXED" ? effect.weightFixedPct : effect.weightRandomPct,
      n: studyN(measure, row.values),
      rob: rob.get(row.studyId) ?? {
        judgment: null,
        judgmentLabel: null,
        bucket: "unassessed",
        classificationCertain: false,
        provenance: null,
        toolId: null,
        toolName: null,
      },
    };
  });

  const rulesInput: GradeRulesInput = {
    measure,
    model,
    nullValue: results.nullValue,
    pooled: {
      estimate: pooled.display.estimate,
      ciLow: pooled.display.ciLow,
      ciHigh: pooled.display.ciHigh,
    },
    heterogeneity: results.heterogeneity
      ? {
          i2: results.heterogeneity.i2,
          q: results.heterogeneity.q,
          df: results.heterogeneity.df,
          p: results.heterogeneity.p,
        }
      : null,
    egger: results.egger ? { p: results.egger.p, k: results.egger.k } : null,
    k,
    totalN: sumStudyN(measure, pooledRows),
    studies,
    startingLevel,
  };
  const applicabilityContext = await gradeApplicabilityContext(db, projectId, results);
  return {
    results,
    pooledRows,
    rulesInput,
    sourceFingerprint: sourceFingerprintFor(rulesInput, applicabilityContext, pooledRows),
  };
}

function assessmentOutOfDate(
  assessment: { sourceFingerprint: string | null },
  liveSourceFingerprint: string | null,
): boolean {
  return (
    liveSourceFingerprint === null ||
    assessment.sourceFingerprint === null ||
    assessment.sourceFingerprint !== liveSourceFingerprint
  );
}

// Postgres jsonb does not preserve object key order, so a plain JSON.stringify comparison
// of stored (round-tripped) vs freshly computed metrics would false-positive on staleness.
// Compare via a recursive key-sorted stringify instead.
function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`);
    return `{${entries.join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function staleAutoDomains(
  assessment: { ratings: GradeDomainRating[] },
  rulesInput: GradeRulesInput | null,
): GradeDomainId[] {
  const autoRatings = assessment.ratings.filter((rating) => rating.origin === "AUTO");
  // Losing the pooled source is itself stale. Keep HUMAN/AI_APPLIED ratings out of the
  // domain list (their preservation is deliberate), while sourceUnavailable separately
  // blocks review and tells the UI why regeneration is unavailable.
  if (rulesInput === null) return autoRatings.map((rating) => rating.domain as GradeDomainId);

  const liveByDomain = new Map(
    draftGradeRatings(rulesInput).ratings.map((rating) => [rating.domain, rating]),
  );
  return GRADE_DOMAIN_ORDER.filter((domain) => {
    const stored = autoRatings.find((rating) => rating.domain === domain);
    if (!stored) return false;
    const live = liveByDomain.get(domain);
    return (
      live !== undefined &&
      (stored.judgment !== live.judgment ||
        stored.requiresReview !== live.requiresReview ||
        stableStringify(stored.metrics) !== stableStringify(live.metrics))
    );
  });
}

// ---------------------------------------------------------------------------
// View
// ---------------------------------------------------------------------------

export async function getGradeView(
  ctx: Ctx,
  projectId: string,
  outcomeId: string,
): Promise<GradeView> {
  await requirePermission(ctx, projectId, "analysis.view");
  return prisma.$transaction(
    async (tx) => {
      await loadOutcome(tx, projectId, outcomeId);
      const [assessment, suggestions, latestRun] = await Promise.all([
        tx.gradeAssessment.findUnique({
          where: { analysisOutcomeId: outcomeId },
          include: ASSESSMENT_INCLUDE,
        }),
        tx.gradeDomainSuggestion.findMany({ where: { analysisOutcomeId: outcomeId } }),
        tx.aiGradeRun.findFirst({
          where: { analysisOutcomeId: outcomeId },
          orderBy: [{ createdAt: "desc" }, { id: "desc" }],
          include: { requestedBy: { select: { id: true, name: true } } },
        }),
      ]);
      const { rulesInput, sourceFingerprint } = await buildDraftInputs(
        ctx,
        projectId,
        outcomeId,
        assessment?.startingLevel ?? "HIGH",
        tx,
      );
      const staleDomains = assessment ? staleAutoDomains(assessment, rulesInput) : [];
      const sourceUnavailable = assessment !== null && rulesInput === null;
      const outOfDate = assessment !== null && assessmentOutOfDate(assessment, sourceFingerprint);
      const domainIndex = (domain: string) =>
        GRADE_DOMAIN_ORDER.indexOf(domain as GradeDomainId);
      return {
        assessment: assessment ? toAssessmentPayload(assessment) : null,
        canDraft: rulesInput !== null,
        staleDomains,
        sourceUnavailable,
        outOfDate,
        suggestions: outOfDate
          ? []
          : [...suggestions].sort((a, b) => domainIndex(a.domain) - domainIndex(b.domain)),
        latestRun,
      };
    },
    { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
  );
}

// Internal publication guard for AI suggestions. Call this from the same repeatable-read
// transaction that inserts suggestions: it binds the run to both the assessment version
// and the complete live source fingerprint without exposing that fingerprint to clients.
export async function gradeAssessmentVersionIsCurrent(
  ctx: Ctx,
  projectId: string,
  outcomeId: string,
  expected: { id: string; updatedAt: Date },
  db: Tx,
): Promise<boolean> {
  const assessment = await db.gradeAssessment.findUnique({
    where: { analysisOutcomeId: outcomeId },
    select: { id: true, updatedAt: true, startingLevel: true, sourceFingerprint: true },
  });
  if (
    assessment === null ||
    assessment.id !== expected.id ||
    assessment.updatedAt.getTime() !== expected.updatedAt.getTime()
  ) {
    return false;
  }
  const { sourceFingerprint } = await buildDraftInputs(
    ctx,
    projectId,
    outcomeId,
    assessment.startingLevel,
    db,
  );
  return !assessmentOutOfDate(assessment, sourceFingerprint);
}

// ---------------------------------------------------------------------------
// Draft generation
// ---------------------------------------------------------------------------

export async function generateDraft(
  ctx: Ctx,
  projectId: string,
  outcomeId: string,
  input: z.infer<typeof generateDraftSchema>,
): Promise<GradeAssessmentPayload> {
  await requirePermission(ctx, projectId, "analysis.manage");
  await loadOutcome(prisma, projectId, outcomeId);

  return gradeWriteTransaction(async (tx) => {
    await lockOutcomeForGradeMutation(tx, projectId, outcomeId);
    const now = new Date();
    const current = await tx.gradeAssessment.findUnique({
      where: { analysisOutcomeId: outcomeId },
      include: { ratings: true },
    });
    const startingLevel: GradeStartingLevel =
      input.startingLevel ?? current?.startingLevel ?? "HIGH";
    // Compute after taking the outcome lock so mappings/exclusions/model changes that use
    // the same parent-first lock cannot interleave with the committed fingerprint.
    const { rulesInput, sourceFingerprint } = await buildDraftInputs(
      ctx,
      projectId,
      outcomeId,
      startingLevel,
      tx,
    );
    if (rulesInput === null || sourceFingerprint === null) {
      throw invalidState(
        "No pooled result — complete extraction and field mappings before drafting GRADE",
      );
    }
    const draft = draftGradeRatings({ ...rulesInput, startingLevel });
    const draftByDomain = new Map(draft.ratings.map((r) => [r.domain, r]));
    // Regeneration replaces only origin=AUTO ratings; human-touched domains keep their
    // judgment and the final certainty is computed over the FINAL five judgments.
    const preservedByDomain = new Map(
      (current?.ratings ?? [])
        .filter((r) => r.origin !== "AUTO")
        .map((r) => [r.domain as GradeDomainId, r]),
    );
    const finalJudgments = GRADE_DOMAIN_ORDER.map(
      (domain) =>
        (preservedByDomain.get(domain)?.judgment as GradeJudgmentId | undefined) ??
        draftByDomain.get(domain)!.judgment,
    );
    const { points, certainty } = computeCertainty(startingLevel, finalJudgments);

    const assessment = await tx.gradeAssessment.upsert({
      where: { analysisOutcomeId: outcomeId },
      create: {
        analysisOutcomeId: outcomeId,
        status: "DRAFT",
        startingLevel,
        certainty,
        generatedAt: now,
        sourceFingerprint,
        createdById: ctx.userId,
      },
      update: {
        startingLevel,
        certainty,
        generatedAt: now,
        sourceFingerprint,
        status: "DRAFT",
        reviewedById: null,
        reviewedAt: null,
      },
    });

    for (const rating of draft.ratings) {
      if (preservedByDomain.has(rating.domain)) continue;
      await tx.gradeDomainRating.upsert({
        where: { assessmentId_domain: { assessmentId: assessment.id, domain: rating.domain } },
        create: {
          assessmentId: assessment.id,
          domain: rating.domain,
          judgment: rating.judgment,
          rationale: rating.rationale,
          origin: "AUTO",
          requiresReview: rating.requiresReview,
          metrics: rating.metrics as Prisma.InputJsonValue,
          updatedById: ctx.userId,
        },
        update: {
          judgment: rating.judgment,
          rationale: rating.rationale,
          requiresReview: rating.requiresReview,
          metrics: rating.metrics as Prisma.InputJsonValue,
          updatedById: ctx.userId,
        },
      });
    }

    // Every suggestion was grounded in the previous assessment/source version.
    await tx.gradeDomainSuggestion.deleteMany({ where: { analysisOutcomeId: outcomeId } });

    await audit.record(tx, {
      projectId,
      userId: ctx.userId,
      entityType: "GradeAssessment",
      entityId: assessment.id,
      action: AuditActions.GRADE_ASSESSMENT_GENERATED,
      metadata: {
        k: rulesInput.k,
        certainty,
        points,
        startingLevel,
        preservedDomains: [...preservedByDomain.keys()],
      },
      newValue: {
        certainty,
        judgments: Object.fromEntries(
          GRADE_DOMAIN_ORDER.map((domain, i) => [domain, finalJudgments[i]]),
        ),
      },
    });

    const fresh = await tx.gradeAssessment.findUniqueOrThrow({
      where: { id: assessment.id },
      include: ASSESSMENT_INCLUDE,
    });
    return toAssessmentPayload(fresh);
  });
}

// ---------------------------------------------------------------------------
// Rating edits + review lifecycle
// ---------------------------------------------------------------------------

export async function updateDomainRating(
  ctx: Ctx,
  projectId: string,
  outcomeId: string,
  domain: GradeDomainId,
  input: z.infer<typeof updateRatingSchema>,
): Promise<GradeAssessmentPayload> {
  await requirePermission(ctx, projectId, "analysis.manage");
  return gradeWriteTransaction(async (tx) => {
    await lockOutcomeForGradeMutation(tx, projectId, outcomeId);
    const assessment = await tx.gradeAssessment.findUnique({
      where: { analysisOutcomeId: outcomeId },
      include: { ratings: true },
    });
    if (!assessment) throw invalidState("Generate the GRADE draft before editing ratings");
    const rating = assessment.ratings.find((r) => r.domain === domain);
    if (!rating) {
      throw invalidState("This domain has no rating yet — regenerate the GRADE draft");
    }

    let judgment = rating.judgment;
    let rationale = rating.rationale;
    let origin: GradeRatingOrigin;
    let aiMetadata: Record<string, unknown> = {};
    if (input.appliedSuggestionId !== undefined) {
      const { sourceFingerprint } = await buildDraftInputs(
        ctx,
        projectId,
        outcomeId,
        assessment.startingLevel,
        tx,
      );
      if (assessmentOutOfDate(assessment, sourceFingerprint)) {
        throw invalidState(
          "The evidence or protocol context changed — regenerate GRADE before applying an AI suggestion",
        );
      }
      // Server-authoritative apply: judgment/rationale come from the suggestion row
      // (client copies are rejected by the schema). R9: the suggestion must belong to
      // this outcome and target this domain.
      const suggestion = await tx.gradeDomainSuggestion.findFirst({
        where: { id: input.appliedSuggestionId, analysisOutcomeId: outcomeId },
      });
      if (!suggestion) throw notFound("GRADE suggestion");
      if (suggestion.domain !== domain) {
        throw validationError("The suggestion does not target this domain", {
          suggestionDomain: suggestion.domain,
          domain,
        });
      }
      judgment = suggestion.suggestedJudgment;
      rationale = suggestion.rationale;
      origin = "AI_APPLIED";
      aiMetadata = {
        appliedFromSuggestionId: suggestion.id,
        aiProvider: suggestion.provider,
        aiModel: suggestion.model,
      };
    } else {
      judgment = input.judgment ?? rating.judgment;
      rationale = input.rationale ?? rating.rationale;
      origin = "HUMAN";
    }

    const changed =
      judgment !== rating.judgment ||
      rationale !== rating.rationale ||
      origin !== rating.origin ||
      rating.requiresReview; // a human touching the rating IS the review

    await tx.gradeDomainRating.update({
      where: { id: rating.id },
      data: { judgment, rationale, origin, requiresReview: false, updatedById: ctx.userId },
    });

    if (changed) {
      const finalJudgments = GRADE_DOMAIN_ORDER.map((d) =>
        d === domain
          ? (judgment as GradeJudgmentId)
          : (assessment.ratings.find((r) => r.domain === d)?.judgment as GradeJudgmentId),
      ).filter((j): j is GradeJudgmentId => j !== undefined);
      const { certainty } = computeCertainty(assessment.startingLevel, finalJudgments);
      await tx.gradeAssessment.update({
        where: { id: assessment.id },
        data: { certainty, status: "DRAFT", reviewedById: null, reviewedAt: null },
      });
      // Suggestions are a coherent set grounded in the pre-edit assessment version.
      await tx.gradeDomainSuggestion.deleteMany({ where: { analysisOutcomeId: outcomeId } });
    }

    await audit.record(tx, {
      projectId,
      userId: ctx.userId,
      entityType: "GradeDomainRating",
      entityId: rating.id,
      action: AuditActions.GRADE_RATING_UPDATED,
      previousValue: {
        judgment: rating.judgment,
        rationale: rating.rationale,
        origin: rating.origin,
      },
      newValue: { judgment, rationale, origin },
      metadata: { analysisOutcomeId: outcomeId, domain, ...aiMetadata },
    });

    const fresh = await tx.gradeAssessment.findUniqueOrThrow({
      where: { id: assessment.id },
      include: ASSESSMENT_INCLUDE,
    });
    return toAssessmentPayload(fresh);
  });
}

export async function setStartingLevel(
  ctx: Ctx,
  projectId: string,
  outcomeId: string,
  input: z.infer<typeof setStartingLevelSchema>,
): Promise<GradeAssessmentPayload> {
  await requirePermission(ctx, projectId, "analysis.manage");
  return gradeWriteTransaction(async (tx) => {
    await lockOutcomeForGradeMutation(tx, projectId, outcomeId);
    const assessment = await tx.gradeAssessment.findUnique({
      where: { analysisOutcomeId: outcomeId },
      include: { ratings: true },
    });
    if (!assessment) {
      throw invalidState("Generate the GRADE draft before setting the starting level");
    }

    const { certainty } = computeCertainty(
      input.startingLevel,
      orderRatings(assessment.ratings).map((r) => r.judgment as GradeJudgmentId),
    );
    const changed =
      assessment.startingLevel !== input.startingLevel || assessment.certainty !== certainty;
    if (changed) {
      await tx.gradeAssessment.update({
        where: { id: assessment.id },
        data: {
          startingLevel: input.startingLevel,
          certainty,
          status: "DRAFT",
          reviewedById: null,
          reviewedAt: null,
        },
      });
      await audit.record(tx, {
        projectId,
        userId: ctx.userId,
        entityType: "GradeAssessment",
        entityId: assessment.id,
        action: AuditActions.GRADE_ASSESSMENT_UPDATED,
        previousValue: {
          startingLevel: assessment.startingLevel,
          certainty: assessment.certainty,
        },
        newValue: { startingLevel: input.startingLevel, certainty },
      });
    }

    const fresh = await tx.gradeAssessment.findUniqueOrThrow({
      where: { id: assessment.id },
      include: ASSESSMENT_INCLUDE,
    });
    return toAssessmentPayload(fresh);
  });
}

export async function markReviewed(
  ctx: Ctx,
  projectId: string,
  outcomeId: string,
): Promise<GradeAssessmentPayload> {
  await requirePermission(ctx, projectId, "analysis.manage");
  // Freshness is checked against caller-independent, final-only inputs. A whole-assessment
  // review acknowledges `requiresReview` flags without changing their provenance, but it
  // may never bless ratings whose underlying pooled source is missing or stale.
  return gradeWriteTransaction(async (tx) => {
    await lockOutcomeForGradeMutation(tx, projectId, outcomeId);
    const assessment = await tx.gradeAssessment.findUnique({
      where: { analysisOutcomeId: outcomeId },
      include: { ratings: true },
    });
    if (!assessment) throw invalidState("Generate the GRADE draft before marking it reviewed");
    const { rulesInput, sourceFingerprint } = await buildDraftInputs(
      ctx,
      projectId,
      outcomeId,
      assessment.startingLevel,
      tx,
    );
    if (rulesInput === null || sourceFingerprint === null) {
      throw invalidState(
        "The pooled result is no longer available — restore the evidence before reviewing GRADE",
      );
    }
    const staleDomains = staleAutoDomains(assessment, rulesInput);
    if (assessmentOutOfDate(assessment, sourceFingerprint)) {
      throw invalidState(
        staleDomains.length > 0
          ? `Results changed for ${staleDomains.join(", ")} — regenerate the GRADE draft before reviewing`
          : "The analysis outcome or protocol applicability context changed — regenerate the GRADE draft before reviewing",
      );
    }
    if (assessment.status === "REVIEWED") {
      throw invalidState("This GRADE assessment is already reviewed");
    }

    await tx.gradeAssessment.update({
      where: { id: assessment.id },
      data: { status: "REVIEWED", reviewedById: ctx.userId, reviewedAt: new Date() },
    });
    await audit.record(tx, {
      projectId,
      userId: ctx.userId,
      entityType: "GradeAssessment",
      entityId: assessment.id,
      action: AuditActions.GRADE_ASSESSMENT_REVIEWED,
      previousValue: { status: assessment.status },
      newValue: { status: "REVIEWED" },
    });

    const fresh = await tx.gradeAssessment.findUniqueOrThrow({
      where: { id: assessment.id },
      include: ASSESSMENT_INCLUDE,
    });
    return toAssessmentPayload(fresh);
  });
}

// ---------------------------------------------------------------------------
// Summary of Findings
// ---------------------------------------------------------------------------

export interface SofRow {
  outcomeId: string;
  name: string;
  timepoint: string | null;
  measure: AnalysisResults["outcome"]["measure"];
  direction: "HIGHER_IS_BETTER" | "LOWER_IS_BETTER";
  model: "FIXED" | "RANDOM";
  groupLabels: { g1: string; g2: string };
  k: number;
  totalN: number | null;
  relative: { estimate: number; ciLow: number; ciHigh: number } | null; // display scale, outcome's model
  absolute: AbsoluteEffect | null; // binary measures only
  proportionPer1000: { estimate: number; ciLow: number; ciHigh: number } | null; // PROPORTION only
  certainty: {
    level: GradeCertaintyId;
    points: number;
    status: GradeAssessmentStatus;
    startingLevel: GradeStartingLevel;
    reviewedByName: string | null;
    stale: boolean;
    sourceUnavailable: boolean;
  } | null;
  footnotes: string[];
}

export interface SofPayload {
  rows: SofRow[];
  generatedAt: string;
}

export interface GradeSnapshot {
  sof: SofPayload;
  assessments: AssessmentWithRatings[];
}

const DOMAIN_PROSE: Record<GradeDomainId, string> = {
  RISK_OF_BIAS: "risk of bias",
  INCONSISTENCY: "inconsistency",
  INDIRECTNESS: "indirectness",
  IMPRECISION: "imprecision",
  PUBLICATION_BIAS: "publication bias",
};

// First sentence keeps review footnotes compact; the full prose lives on the rating.
function shortReason(rationale: string): string {
  const idx = rationale.indexOf(". ");
  return idx === -1 ? rationale : rationale.slice(0, idx + 1);
}

function footnotesFor(ratings: GradeDomainRating[], includeReviewFlags: boolean): string[] {
  const notes: string[] = [];
  for (const rating of ratings) {
    if (rating.judgment !== "NOT_SERIOUS") {
      const n = rating.judgment === "SERIOUS" ? 1 : 2;
      notes.push(
        `Downgraded (−${n}) for ${DOMAIN_PROSE[rating.domain as GradeDomainId]}: ${rating.rationale}`,
      );
    }
  }
  if (includeReviewFlags) {
    for (const rating of ratings) {
      if (rating.requiresReview) {
        notes.push(
          `Review required — ${DOMAIN_PROSE[rating.domain as GradeDomainId]}: ${shortReason(rating.rationale)}`,
        );
      }
    }
  }
  return notes;
}

async function computeGradeSnapshotInTx(
  ctx: Ctx,
  projectId: string,
  tx: Tx,
): Promise<GradeSnapshot> {
  const [outcomes, assessments] = await Promise.all([
    tx.analysisOutcome.findMany({
      where: { projectId },
      orderBy: [{ order: "asc" }, { createdAt: "asc" }],
      select: { id: true },
    }),
    tx.gradeAssessment.findMany({
      where: { outcome: { projectId } },
      orderBy: [{ outcome: { order: "asc" } }, { id: "asc" }],
      include: ASSESSMENT_INCLUDE,
    }),
  ]);
  const assessmentByOutcome = new Map(assessments.map((a) => [a.analysisOutcomeId, a]));

  const rows: SofRow[] = [];
  for (const { id } of outcomes) {
    const results = await computeOutcomeResults(ctx, projectId, id, { finalOnly: true }, tx);
    const outcome = results.outcome;
    const measure = outcome.measure;
    const pooledRows = results.rows.filter((r) => r.effect !== null);
    const k = pooledRows.length;
    const est = outcome.model === "FIXED" ? results.pooled.fixed : results.pooled.random;

    // Anticipated absolute effects: binary measures only, assumed risk = median of the
    // pooled studies' comparator risks (e2/n2), corresponding via the pooled display effect.
    let absolute: AbsoluteEffect | null = null;
    if (est && (measure === "RR" || measure === "OR" || measure === "RD")) {
      const risks: number[] = [];
      for (const row of pooledRows) {
        const e2 = row.values["G2_EVENTS"]?.value ?? null;
        const n2 = row.values["G2_TOTAL"]?.value ?? null;
        if (e2 !== null && n2 !== null && n2 > 0) risks.push(e2 / n2);
      }
      const assumed = medianControlRiskPer1000(risks);
      if (assumed !== null) {
        absolute = absoluteFromRelative(
          measure,
          assumed,
          est.display.estimate,
          est.display.ciLow,
          est.display.ciHigh,
        );
      }
    }

    const assessment = assessmentByOutcome.get(id) ?? null;
    const orderedRatings = assessment ? orderRatings(assessment.ratings) : [];
    const { rulesInput, sourceFingerprint } = assessment
      ? await buildDraftInputs(ctx, projectId, id, assessment.startingLevel, tx, results)
      : { rulesInput: null, sourceFingerprint: null };
    const staleDomains = assessment ? staleAutoDomains(assessment, rulesInput) : [];
    const sourceUnavailable = assessment !== null && rulesInput === null;
    const gradeOutOfDate =
      assessment !== null && assessmentOutOfDate(assessment, sourceFingerprint);
    const points = assessment
      ? computeCertainty(
          assessment.startingLevel,
          orderedRatings.map((r) => r.judgment as GradeJudgmentId),
        ).points
      : 0;

    rows.push({
      outcomeId: id,
      name: outcome.name,
      timepoint: outcome.timepoint,
      measure,
      direction: outcome.direction,
      model: outcome.model,
      groupLabels: results.groupLabels,
      k,
      totalN: sumStudyN(measure, pooledRows),
      relative:
        est && measure !== "PROPORTION"
          ? {
              estimate: est.display.estimate,
              ciLow: est.display.ciLow,
              ciHigh: est.display.ciHigh,
            }
          : null,
      absolute,
      proportionPer1000:
        est && measure === "PROPORTION"
          ? {
              estimate: est.display.estimate * 1000,
              ciLow: est.display.ciLow * 1000,
              ciHigh: est.display.ciHigh * 1000,
            }
          : null,
      certainty: assessment
        ? {
            level: assessment.certainty as GradeCertaintyId,
            points,
            status: assessment.status,
            startingLevel: assessment.startingLevel,
            reviewedByName: assessment.reviewedBy?.name ?? null,
            stale: gradeOutOfDate,
            sourceUnavailable,
          }
        : null,
      footnotes: assessment
        ? gradeOutOfDate
          ? [
              sourceUnavailable
                ? "GRADE assessment is out of date: no study currently contributes to the pooled result."
                : staleDomains.length > 0
                  ? `GRADE assessment is out of date for ${staleDomains.map((domain) => DOMAIN_PROSE[domain]).join(", ")}.`
                  : "GRADE assessment is out of date: the analysis outcome or protocol applicability context changed.",
            ]
          : footnotesFor(orderedRatings, assessment.status !== "REVIEWED")
        : [],
    });
  }

  return { sof: { rows, generatedAt: new Date().toISOString() }, assessments };
}

export async function computeGradeSnapshot(
  ctx: Ctx,
  projectId: string,
): Promise<GradeSnapshot> {
  await requirePermission(ctx, projectId, "analysis.view");
  return prisma.$transaction((tx) => computeGradeSnapshotInTx(ctx, projectId, tx), {
    isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead,
  });
}

export async function computeSof(ctx: Ctx, projectId: string): Promise<SofPayload> {
  return (await computeGradeSnapshot(ctx, projectId)).sof;
}
