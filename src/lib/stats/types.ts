// Shared types for the meta-analysis statistics library (src/lib/stats).
//
// CONTRACT NOTES (binding for all consumers):
// - Everything in this library is PURE, DETERMINISTIC TypeScript. No AI, no I/O, no
//   randomness. Every number on a forest plot or in a pooled estimate comes from here and
//   is validated against independently generated golden fixtures (scipy reference
//   implementation committed under __fixtures__/).
// - `y`/`se`/`ciLow`/`ciHigh` are on the ANALYSIS scale (natural log for RR/OR; identity
//   for RD/MD/SMD). `display` blocks are back-transformed to the reporting scale
//   (exp() for log-scale measures; identity otherwise).
// - computeMeta never throws on bad study data — studies that cannot contribute are
//   returned in `excluded` with a human-readable reason.

// Phase A measures. PROPORTION and GENERIC_IV arrive in phase B (enum already in Prisma).
export type EffectMeasureId = "RR" | "OR" | "RD" | "MD" | "SMD";

export type AnalysisScale = "log" | "linear";

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

export type StudyData =
  | { kind: "binary"; counts: BinaryCounts }
  | { kind: "continuous"; stats: ContinuousStats };

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

export interface MetaResult {
  measure: EffectMeasureId;
  scale: AnalysisScale;
  nullValue: number | null; // DISPLAY scale: 1 for RR/OR, 0 for RD/MD/SMD
  studies: StudyEffectResult[]; // included studies, input order preserved
  excluded: ExcludedStudy[];
  fixed: PooledEstimate | null; // null when no studies pool
  random: PooledEstimate | null;
  heterogeneity: Heterogeneity | null; // null when fewer than 2 studies pool
}

export interface ComputeMetaOptions {
  measure: EffectMeasureId;
}

export function scaleFor(measure: EffectMeasureId): AnalysisScale {
  return measure === "RR" || measure === "OR" ? "log" : "linear";
}

export function nullValueFor(measure: EffectMeasureId): number {
  return measure === "RR" || measure === "OR" ? 1 : 0;
}
