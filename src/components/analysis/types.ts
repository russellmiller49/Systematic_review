// Shared client-side types + helpers for the analysis (meta-analysis) page.
// Interfaces mirror ONLY what the analysis API returns (outcome CRUD, mappings,
// computed results); stats shapes mirror the stats-lib display contract. Nothing
// here is authoritative — the server recomputes and re-validates everything.

import { ApiError } from "@/lib/api";

// --- Outcomes ------------------------------------------------------------------

export type EffectMeasure = "RR" | "OR" | "RD" | "MD" | "SMD" | "PROPORTION" | "GENERIC_IV";
export type EffectDirection = "HIGHER_IS_BETTER" | "LOWER_IS_BETTER";
export type PoolingModel = "FIXED" | "RANDOM";
export type ProportionTransform = "LOGIT" | "FREEMAN_TUKEY";

export interface GroupLabels {
  g1?: string;
  g2?: string;
}

export interface AnalysisMapping {
  role: string;
  templateId: string;
  fieldKey: string;
}

// GET/POST/PATCH /analysis/outcomes row.
export interface AnalysisOutcomeRow {
  id: string;
  name: string;
  timepoint: string | null;
  measure: EffectMeasure;
  direction: EffectDirection;
  model: PoolingModel;
  proportionTransform: ProportionTransform; // meaningful for PROPORTION only
  groupLabels: GroupLabels | null;
  order: number;
  outcomeDefinitionId: string | null;
  mappings: AnalysisMapping[];
  requiredRoles: string[];
  mappingComplete: boolean;
}

// Protocol outcome definitions (GET /protocol → outcomes) — the optional anchor picker.
export interface ProtocolOutcomeOption {
  id: string;
  name: string;
  measure: string | null;
  timepoint: string | null;
}

// --- Results (GET /analysis/outcomes/:outcomeId/results) ------------------------

export interface EffectDisplay {
  estimate: number;
  ciLow: number;
  ciHigh: number;
}

// Mirrors stats-lib StudyEffectResult (display values are on the measure's scale).
export interface StudyEffectResult {
  id: string;
  label: string;
  y: number;
  se: number;
  ciLow: number;
  ciHigh: number;
  display: EffectDisplay;
  weightFixedPct: number;
  weightRandomPct: number;
}

// Mirrors stats-lib PooledEstimate.
export interface PooledEstimate {
  model: string;
  y: number;
  se: number;
  ciLow: number;
  ciHigh: number;
  display: EffectDisplay;
  z: number;
  p: number;
}

// Mirrors stats-lib Heterogeneity.
export interface Heterogeneity {
  q: number;
  df: number;
  p: number;
  i2: number;
  tau2: number;
}

// Mirrors stats-lib PredictionInterval (random effects, k >= 3 only).
export interface PredictionInterval {
  low: number;
  high: number;
  display: { low: number; high: number };
}

// Mirrors stats-lib EggerResult (k >= 3 only).
export interface EggerResult {
  intercept: number;
  interceptSe: number;
  t: number;
  p: number;
  k: number;
}

// Analysis scale ("logit"/"ft" are PROPORTION's transformed scales) + how display
// values relate to it (harmonicN parameterizes the FT inverse for pooled values).
export type AnalysisScale = "log" | "linear" | "logit" | "ft";

export interface DisplayMeta {
  transform: "identity" | "exp" | "invlogit" | "ft";
  harmonicN: number | null;
}

export type RowStatus =
  | "included"
  | "provisional"
  | "disputed"
  | "incomplete"
  | "excluded"
  | "not-pooled";

export type ValueSource = "ADJUDICATED" | "CONSENSUS" | "SINGLE" | "PROVISIONAL";

export interface RoleValue {
  value: number | null;
  source: ValueSource | null;
}

export interface AnalysisResultRow {
  studyId: string;
  label: string;
  inQuantitativeSynthesis: boolean;
  status: RowStatus;
  reason: string | null;
  values: Record<string, RoleValue>;
  effect: StudyEffectResult | null;
}

export interface AnalysisResults {
  outcome: AnalysisOutcomeRow;
  groupLabels: { g1: string; g2: string }; // PROPORTION uses g1 only (the cohort)
  rows: AnalysisResultRow[];
  pooled: { fixed: PooledEstimate | null; random: PooledEstimate | null };
  heterogeneity: Heterogeneity | null;
  predictionInterval: PredictionInterval | null;
  egger: EggerResult | null;
  scale: AnalysisScale;
  nullValue: number | null; // null for PROPORTION — the forest plot omits the null line
  displayMeta: DisplayMeta;
  // False when the caller may not see provisional/blinded data — the server then
  // ignores ?provisional=1 and the UI hides the "Include provisional" toggle.
  provisionalAllowed: boolean;
}

// --- Presentation metadata -------------------------------------------------------

export const MEASURE_LABELS: Record<EffectMeasure, string> = {
  RR: "Risk ratio",
  OR: "Odds ratio",
  RD: "Risk difference",
  MD: "Mean difference",
  SMD: "Std. mean difference (Hedges g)",
  PROPORTION: "Proportion (single arm)",
  GENERIC_IV: "Generic inverse variance",
};

// Ordered options for the create dialog's measure select.
export const MEASURE_OPTIONS: { value: EffectMeasure; label: string }[] = [
  { value: "RR", label: "Risk ratio" },
  { value: "OR", label: "Odds ratio" },
  { value: "RD", label: "Risk difference" },
  { value: "MD", label: "Mean difference" },
  { value: "SMD", label: "Std. mean difference (Hedges g)" },
  { value: "PROPORTION", label: "Proportion (single arm)" },
  { value: "GENERIC_IV", label: "Generic inverse variance" },
];

export const PROPORTION_TRANSFORM_LABELS: Record<ProportionTransform, string> = {
  LOGIT: "Logit",
  FREEMAN_TUKEY: "Freeman–Tukey (double arcsine)",
};

const BINARY_MEASURES: readonly EffectMeasure[] = ["RR", "OR", "RD"];

export function isBinaryMeasure(measure: EffectMeasure): boolean {
  return BINARY_MEASURES.includes(measure);
}

const CONTINUOUS_MEASURES: readonly EffectMeasure[] = ["MD", "SMD"];

export function isContinuousMeasure(measure: EffectMeasure): boolean {
  return CONTINUOUS_MEASURES.includes(measure);
}

export const DIRECTION_LABELS: Record<EffectDirection, string> = {
  LOWER_IS_BETTER: "Lower is better",
  HIGHER_IS_BETTER: "Higher is better",
};

export const MODEL_LABELS: Record<PoolingModel, string> = {
  FIXED: "Fixed effect",
  RANDOM: "Random effects (DL)",
};

type AnalysisBadgeVariant = "include" | "exclude" | "maybe" | "muted" | "secondary" | "outline";

// Per-study row status → badge + fallback reason (used when the API omits one).
export const ROW_STATUS_META: Record<
  RowStatus,
  { label: string; variant: AnalysisBadgeVariant; fallbackReason: string }
> = {
  included: { label: "Included", variant: "include", fallbackReason: "" },
  provisional: {
    label: "Provisional",
    variant: "maybe",
    fallbackReason: "Uses values from an in-progress extraction form",
  },
  disputed: {
    label: "Disputed",
    variant: "exclude",
    fallbackReason: "Extractors disagree on a mapped value",
  },
  incomplete: {
    label: "Incomplete",
    variant: "muted",
    fallbackReason: "A required value has not been extracted yet",
  },
  excluded: { label: "Excluded", variant: "secondary", fallbackReason: "Manually excluded" },
  "not-pooled": {
    label: "Not pooled",
    variant: "outline",
    fallbackReason: "Rejected by the stats engine",
  },
};

// Provenance chips for resolved values (styled like the extraction matrix badges).
export const SOURCE_BADGE: Record<ValueSource, { label: string; variant: AnalysisBadgeVariant }> = {
  ADJUDICATED: { label: "Adjudicated", variant: "include" },
  CONSENSUS: { label: "Consensus", variant: "secondary" },
  SINGLE: { label: "Single", variant: "muted" },
  PROVISIONAL: { label: "Provisional", variant: "maybe" },
};

// --- Small formatting helpers -----------------------------------------------------

/** PROPORTION is single-arm: its default G1 label is "Cohort" (mirrors the server). */
export function resolveGroupLabels(
  labels: GroupLabels | null | undefined,
  measure?: EffectMeasure,
): {
  g1: string;
  g2: string;
} {
  return {
    g1: labels?.g1 || (measure === "PROPORTION" ? "Cohort" : "Group 1"),
    g2: labels?.g2 || "Group 2",
  };
}

const ROLE_SUFFIX_LABELS: Record<string, string> = {
  EVENTS: "events",
  TOTAL: "total",
  MEAN: "mean",
  SD: "SD",
  N: "n",
};

const EFFECT_ROLE_LABELS: Record<string, string> = {
  EFFECT_ESTIMATE: "Effect estimate",
  EFFECT_SE: "Standard error",
  EFFECT_CI_LOW: "95% CI lower",
  EFFECT_CI_UP: "95% CI upper",
};

/**
 * "G1_EVENTS" + {g1: "Stent"} → "Stent events"; EFFECT_* roles get fixed labels;
 * anything else falls back to the raw key.
 */
export function roleLabel(role: string, groups: { g1: string; g2: string }): string {
  const effectLabel = EFFECT_ROLE_LABELS[role];
  if (effectLabel) return effectLabel;
  const match = /^(G1|G2)_(.+)$/.exec(role);
  const group = match?.[1];
  const suffix = match?.[2];
  if (!group || !suffix) return role;
  const groupLabel = group === "G1" ? groups.g1 : groups.g2;
  return `${groupLabel} ${ROLE_SUFFIX_LABELS[suffix] ?? suffix.toLowerCase()}`;
}

/** Raw extracted number for table/plot data columns; integers stay unadorned. */
export function fmtValue(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "—";
  if (Number.isInteger(value)) return String(value);
  return value.toFixed(2).replace(/\.?0+$/, "");
}

/** Effect estimate / CI bound on the display scale. */
export function fmtEstimate(value: number): string {
  if (!Number.isFinite(value)) return "—";
  return Math.abs(value) >= 100 ? value.toFixed(1) : value.toFixed(2);
}

/** "0.49 [0.32, 0.76]" */
export function fmtCi(display: EffectDisplay): string {
  return `${fmtEstimate(display.estimate)} [${fmtEstimate(display.ciLow)}, ${fmtEstimate(display.ciHigh)}]`;
}

export function fmtP(p: number): string {
  if (!Number.isFinite(p)) return "—";
  return p < 0.001 ? "<0.001" : p.toFixed(3);
}

export function slugify(name: string): string {
  const slug = name
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/g, "-")
    .replaceAll(/^-+|-+$/g, "");
  return slug || "outcome";
}

// Flattens ApiError.details (zod flatten() or service-provided lists) into messages
// suitable for inline display; falls back to the top-level message.
export function apiErrorMessages(err: unknown): string[] {
  if (!(err instanceof ApiError)) {
    return [err instanceof Error ? err.message : "Request failed"];
  }
  const messages: string[] = [];
  const details = err.details;
  if (Array.isArray(details)) {
    for (const item of details) {
      if (typeof item === "string") messages.push(item);
      else if (
        item !== null &&
        typeof item === "object" &&
        typeof (item as { message?: unknown }).message === "string"
      ) {
        messages.push((item as { message: string }).message);
      }
    }
  } else if (details !== null && typeof details === "object") {
    const flat = details as { formErrors?: unknown; fieldErrors?: unknown };
    if (Array.isArray(flat.formErrors)) {
      messages.push(...flat.formErrors.filter((m): m is string => typeof m === "string"));
    }
    if (flat.fieldErrors !== null && typeof flat.fieldErrors === "object") {
      for (const [key, value] of Object.entries(flat.fieldErrors as Record<string, unknown>)) {
        if (!Array.isArray(value)) continue;
        for (const m of value) if (typeof m === "string") messages.push(`${key}: ${m}`);
      }
    }
  }
  return messages.length > 0 ? messages : [err.message];
}

// --- Capability gating -------------------------------------------------------
// UI-gating mirror of the analysis rows of src/server/permissions/matrix.ts.
// The server stays authoritative — every call also handles 403 gracefully.

export type AnalysisCapability = "analysis.view" | "analysis.manage";

const CAP_ROLES: Record<AnalysisCapability, readonly string[]> = {
  "analysis.view": ["OWNER", "ADMIN", "STATISTICIAN", "ADJUDICATOR", "PANEL_MEMBER", "OBSERVER"],
  "analysis.manage": ["OWNER", "ADMIN", "STATISTICIAN"],
};

export function hasCap(
  roles: readonly string[] | null | undefined,
  cap: AnalysisCapability,
): boolean {
  return Array.isArray(roles) && roles.some((r) => CAP_ROLES[cap].includes(r));
}

// --- GRADE certainty (mirrors the grade API payloads) -----------------------------

export type GradeDomainId =
  | "RISK_OF_BIAS"
  | "INCONSISTENCY"
  | "INDIRECTNESS"
  | "IMPRECISION"
  | "PUBLICATION_BIAS";
export type GradeJudgmentId = "NOT_SERIOUS" | "SERIOUS" | "VERY_SERIOUS";
export type GradeCertaintyId = "HIGH" | "MODERATE" | "LOW" | "VERY_LOW";
export type RobBucket = "low" | "moderate" | "high" | "unclear" | "unassessed";
export type GradeStartingLevel = "HIGH" | "LOW";
export type GradeAssessmentStatus = "DRAFT" | "REVIEWED";
export type GradeRatingOrigin = "AUTO" | "HUMAN" | "AI_APPLIED";

export interface GradeRatingPayload {
  id: string;
  domain: GradeDomainId;
  judgment: GradeJudgmentId;
  rationale: string;
  origin: GradeRatingOrigin;
  requiresReview: boolean;
  metrics: Record<string, unknown> | null;
  updatedAt: string;
}

export interface GradeAssessmentPayload {
  id: string;
  status: GradeAssessmentStatus;
  startingLevel: GradeStartingLevel;
  certainty: GradeCertaintyId;
  points: number;
  generatedAt: string;
  reviewedAt: string | null;
  reviewedBy: { id: string; name: string } | null;
  ratings: GradeRatingPayload[];
}

export interface GradeSuggestionPayload {
  id: string;
  domain: GradeDomainId;
  suggestedJudgment: GradeJudgmentId;
  rationale: string;
  confidence: number | null;
  provider: string;
  model: string;
  createdAt: string;
}

// Latest AI prose run (display only — suggestions ride alongside in GradeView).
export interface GradeRunPayload {
  id: string;
  status: "PENDING" | "SUBMITTED" | "COMPLETED" | "FAILED" | "CANCELED";
  provider: string;
  model: string;
  totalDomains: number;
  suggestedCount: number;
  invalidCount: number;
  error: string | null;
  createdAt: string;
  completedAt: string | null;
}

// GET /analysis/outcomes/:outcomeId/grade
export interface GradeView {
  assessment: GradeAssessmentPayload | null;
  canDraft: boolean;
  staleDomains: GradeDomainId[];
  sourceUnavailable: boolean;
  outOfDate: boolean;
  suggestions: GradeSuggestionPayload[];
  latestRun: GradeRunPayload | null;
}

// --- Summary of findings (GET /analysis/sof) --------------------------------------

export interface SofAbsoluteEffect {
  assumedPer1000: number;
  correspondingPer1000: number;
  correspondingCiLowPer1000: number;
  correspondingCiHighPer1000: number;
}

export interface SofCertainty {
  level: GradeCertaintyId;
  points: number;
  status: GradeAssessmentStatus;
  startingLevel: GradeStartingLevel;
  reviewedByName: string | null;
  stale: boolean;
  sourceUnavailable: boolean;
}

export interface SofRow {
  outcomeId: string;
  name: string;
  timepoint: string | null;
  measure: EffectMeasure;
  direction: EffectDirection;
  model: PoolingModel;
  groupLabels: { g1: string; g2: string };
  k: number;
  totalN: number | null;
  relative: EffectDisplay | null; // display scale, the outcome's model
  absolute: SofAbsoluteEffect | null; // binary measures with control risks only
  proportionPer1000: EffectDisplay | null; // PROPORTION only, ×1000
  certainty: SofCertainty | null;
  footnotes: string[];
}

export interface SofPayload {
  rows: SofRow[];
  generatedAt: string;
}

export interface SofCertaintyPresentation {
  certaintyText: string;
  statusText: string;
  detail: string | null;
  outOfDate: boolean;
}

/** Shared table/CSV wording so stale saved certainty is never presented as current. */
export function sofCertaintyPresentation(
  certainty: SofCertainty,
): SofCertaintyPresentation {
  const label = CERTAINTY_META[certainty.level].label;
  const outOfDate = certainty.stale || certainty.sourceUnavailable;
  if (outOfDate) {
    return {
      certaintyText: `${label} (out of date)`,
      statusText: certainty.sourceUnavailable ? "Source unavailable" : "Out of date",
      detail: certainty.sourceUnavailable
        ? "No study currently contributes to the pooled result; this saved certainty is out of date."
        : "Evidence or protocol context changed; regenerate GRADE before using this saved certainty.",
      outOfDate: true,
    };
  }
  return {
    certaintyText: label,
    statusText: certainty.status === "REVIEWED" ? "Reviewed" : "Draft",
    detail: null,
    outOfDate: false,
  };
}

// --- GRADE presentation metadata ---------------------------------------------------

export const DOMAIN_ORDER: readonly GradeDomainId[] = [
  "RISK_OF_BIAS",
  "INCONSISTENCY",
  "INDIRECTNESS",
  "IMPRECISION",
  "PUBLICATION_BIAS",
];

export const DOMAIN_LABELS: Record<GradeDomainId, string> = {
  RISK_OF_BIAS: "Risk of bias",
  INCONSISTENCY: "Inconsistency",
  INDIRECTNESS: "Indirectness",
  IMPRECISION: "Imprecision",
  PUBLICATION_BIAS: "Publication bias",
};

export const JUDGMENT_META: Record<
  GradeJudgmentId,
  { label: string; variant: AnalysisBadgeVariant }
> = {
  NOT_SERIOUS: { label: "Not serious", variant: "include" },
  SERIOUS: { label: "Serious", variant: "maybe" },
  VERY_SERIOUS: { label: "Very serious", variant: "exclude" },
};

// GRADE plus/circle notation + one color per level. LOW sits between the amber and
// red theme tokens, so it uses the stock orange palette (the app is light-only).
export const CERTAINTY_META: Record<
  GradeCertaintyId,
  { label: string; symbols: string; colorClass: string }
> = {
  HIGH: {
    label: "High",
    symbols: "⊕⊕⊕⊕",
    colorClass: "border-include/30 bg-include-muted text-include",
  },
  MODERATE: {
    label: "Moderate",
    symbols: "⊕⊕⊕◯",
    colorClass: "border-lime-600/30 bg-lime-100 text-lime-700",
  },
  LOW: {
    label: "Low",
    symbols: "⊕⊕◯◯",
    colorClass: "border-orange-600/30 bg-orange-100 text-orange-700",
  },
  VERY_LOW: {
    label: "Very low",
    symbols: "⊕◯◯◯",
    colorClass: "border-exclude/30 bg-exclude-muted text-exclude",
  },
};

export const ORIGIN_LABELS: Record<GradeRatingOrigin, string> = {
  AUTO: "Auto",
  HUMAN: "Edited",
  AI_APPLIED: "AI-assisted",
};

export const STARTING_LEVEL_LABELS: Record<GradeStartingLevel, string> = {
  HIGH: "High — randomized evidence",
  LOW: "Low — observational evidence",
};

export const STARTING_POINTS: Record<GradeStartingLevel, number> = { HIGH: 4, LOW: 2 };

/** "Started HIGH (4) − 1 = 3 → Moderate" (deduction shown after the ≥1 floor). */
export function pointsArithmetic(
  startingLevel: GradeStartingLevel,
  points: number,
  certainty: GradeCertaintyId,
): string {
  const start = STARTING_POINTS[startingLevel];
  return `Started ${startingLevel} (${start}) − ${start - points} = ${points} → ${CERTAINTY_META[certainty].label}`;
}

const SUPERSCRIPT_DIGITS = ["⁰", "¹", "²", "³", "⁴", "⁵", "⁶", "⁷", "⁸", "⁹"] as const;

/** 12 → "¹²" — footnote markers for the summary-of-findings table. */
export function superscriptMarker(n: number): string {
  return [...String(n)].map((d) => SUPERSCRIPT_DIGITS[Number(d)] ?? d).join("");
}
