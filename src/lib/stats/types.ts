// Shared types for the meta-analysis statistics library (src/lib/stats).
//
// CONTRACT NOTES (binding for all consumers):
// - Everything in this library is PURE, DETERMINISTIC TypeScript. No AI, no I/O, no
//   randomness. Every number on a forest plot or in a pooled estimate comes from here and
//   is validated against independently generated golden fixtures (scipy reference
//   implementation committed under __fixtures__/).
// - `y`/`se`/`ciLow`/`ciHigh` are on the ANALYSIS scale (natural log for RR/OR; logit or
//   Freeman–Tukey double-arcsine for PROPORTION; identity for RD/MD/SMD/GENERIC_IV).
//   `display` blocks are back-transformed to the reporting scale (exp() on the log scale;
//   inverse logit / Miller's inverse double-arcsine for proportions — per-study with that
//   study's own n, pooled with the HARMONIC MEAN of the included n's; identity otherwise).
// - computeMeta never throws on bad study data — studies that cannot contribute are
//   returned in `excluded` with a human-readable reason.

export type EffectMeasureId = "RR" | "OR" | "RD" | "MD" | "SMD" | "PROPORTION" | "GENERIC_IV";

export type ProportionTransformId = "LOGIT" | "FREEMAN_TUKEY";

// Analysis scale: "logit"/"ft" are PROPORTION's transformed scales (linear pooling on the
// transform; display back-transformed to proportions).
export type AnalysisScale = "log" | "linear" | "logit" | "ft";

// Binary 2x2: group 1 = intervention/exposure, group 2 = comparator.
export interface BinaryCounts {
  e1: number; // events in group 1
  n1: number; // total in group 1
  e2: number;
  n2: number;
}

export interface ContinuousStats {
  m1: number; // mean, group 1
  sd1: number;
  n1: number;
  m2: number;
  sd2: number;
  n2: number;
}

// Single-arm proportion: e events out of n.
export interface ProportionCounts {
  e: number;
  n: number;
}

// Pre-computed effect on the pooling scale (GENERIC_IV). se wins when present;
// otherwise the SE is derived from the 95% CI bounds (see effects/generic.ts).
export interface GenericStats {
  y: number;
  se: number | null;
  ciLow: number | null;
  ciUp: number | null;
}

export type StudyData =
  | { kind: "binary"; counts: BinaryCounts }
  | { kind: "continuous"; stats: ContinuousStats }
  | { kind: "proportion"; counts: ProportionCounts }
  | { kind: "generic"; stats: GenericStats };

export interface StudyEffectInput {
  id: string;
  label: string;
  data: StudyData;
}

// Per-study effect estimate on the analysis scale (pre-pooling).
export interface EffectEstimate {
  y: number;
  se: number;
}

export interface DisplayEstimate {
  estimate: number;
  ciLow: number;
  ciHigh: number;
}

export interface StudyEffectResult {
  id: string;
  label: string;
  y: number;
  se: number;
  ciLow: number;
  ciHigh: number;
  display: DisplayEstimate;
  weightFixedPct: number; // percentage weights, sum to ~100 across included studies
  weightRandomPct: number;
}

export interface ExcludedStudy {
  id: string;
  label: string;
  reason: string; // e.g. "double-zero study (no events in either group) — excluded from RR/OR"
}

export interface PooledEstimate {
  model: "FIXED" | "RANDOM";
  y: number;
  se: number;
  ciLow: number;
  ciHigh: number;
  display: DisplayEstimate;
  z: number;
  p: number; // two-sided
}

export interface Heterogeneity {
  q: number;
  df: number;
  p: number; // upper-tail chi-square
  i2: number; // percent, 0–100
  tau2: number; // DerSimonian-Laird
}

// Random-effects prediction interval (Higgins/Thompson/Spiegelhalter; matches metafor
// predict() default): ŷ_RE ± t_{0.975, k−2}·√(τ² + SE(ŷ_RE)²). Null when k < 3.
export interface PredictionInterval {
  low: number; // analysis scale
  high: number;
  display: { low: number; high: number }; // back-transformed like the pooled estimate
}

// Egger's regression test (see egger.ts). Null when k < 3 or degenerate.
export interface EggerResult {
  intercept: number;
  interceptSe: number;
  t: number; // intercept / interceptSe
  p: number; // two-sided, Student-t at df = k − 2
  k: number;
}

// How display values relate to the analysis scale — everything a client needs to draw
// back-transformed axis ticks (harmonicN parameterizes the FT inverse for pooled values).
export interface DisplayMeta {
  transform: "identity" | "exp" | "invlogit" | "ft";
  harmonicN: number | null; // harmonic mean of included studies' n (FT only, null otherwise)
}

export interface MetaResult {
  measure: EffectMeasureId;
  scale: AnalysisScale;
  nullValue: number | null; // DISPLAY scale: 1 for RR/OR, 0 for RD/MD/SMD/GENERIC_IV, null for PROPORTION
  studies: StudyEffectResult[]; // included studies, input order preserved
  excluded: ExcludedStudy[];
  fixed: PooledEstimate | null; // null when no studies pool
  random: PooledEstimate | null;
  heterogeneity: Heterogeneity | null; // null when fewer than 2 studies pool
  predictionInterval: PredictionInterval | null; // random effects, k >= 3 only
  egger: EggerResult | null; // k >= 3 only
  displayMeta: DisplayMeta;
}

export interface ComputeMetaOptions {
  measure: EffectMeasureId;
  proportionTransform?: ProportionTransformId; // PROPORTION only; defaults to LOGIT
}

export function scaleFor(
  measure: EffectMeasureId,
  proportionTransform: ProportionTransformId = "LOGIT",
): AnalysisScale {
  if (measure === "RR" || measure === "OR") return "log";
  if (measure === "PROPORTION") return proportionTransform === "FREEMAN_TUKEY" ? "ft" : "logit";
  return "linear";
}

/** Display-scale null value; PROPORTION has no meaningful null (single arm) — null. */
export function nullValueFor(measure: EffectMeasureId): number | null {
  if (measure === "RR" || measure === "OR") return 1;
  if (measure === "PROPORTION") return null;
  return 0;
}
