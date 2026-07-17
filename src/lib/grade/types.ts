// Shared types for the deterministic GRADE rules library (src/lib/grade).
//
// CONTRACT NOTES (binding for all consumers):
// - Everything in this library is PURE, DETERMINISTIC TypeScript. No AI, no I/O, no
//   imports from server code. AI participates in GRADE only by writing suggestion rows
//   that a human applies — never through these rules.
// - All effect-size inputs (`pooled`, `nullValue`) are on the DISPLAY scale (the
//   back-transformed `display` blocks from src/lib/stats), matching what reviewers see.
// - Every DomainDraft rationale quotes the actual numbers it used; `metrics` snapshots
//   the same numbers rounded via round4() so stored ratings can be compared against a
//   live recomputation for staleness.

export type GradeDomainId =
  | "RISK_OF_BIAS"
  | "INCONSISTENCY"
  | "INDIRECTNESS"
  | "IMPRECISION"
  | "PUBLICATION_BIAS";
export type GradeJudgmentId = "NOT_SERIOUS" | "SERIOUS" | "VERY_SERIOUS";
export type GradeCertaintyId = "HIGH" | "MODERATE" | "LOW" | "VERY_LOW";
export type RobBucket = "low" | "moderate" | "high" | "unclear" | "unassessed";

export interface GradeStudyInput {
  studyId: string;
  label: string;
  weightPct: number; // % weight under the outcome's display model
  n: number | null; // total participants in this study (all mapped arms), null unknown
  rob: {
    judgment: string | null; // resolved judgment VALUE (e.g. "low"), null when unassessed
    judgmentLabel: string | null; // display label (e.g. "Low risk")
    bucket: RobBucket;
    classificationCertain: boolean; // false when the tool scale cannot be ranked authoritatively
    provenance: "adjudicated" | "consensus" | "single" | "derived-from-domains" | null; // null when unassessed
    toolId: string | null;
    toolName: string | null;
  };
}

export interface GradeRulesInput {
  measure: "RR" | "OR" | "RD" | "MD" | "SMD" | "PROPORTION" | "GENERIC_IV";
  model: "FIXED" | "RANDOM"; // which pooled estimate/weights the rules read
  nullValue: number | null; // display scale (1 RR/OR, 0 others, null PROPORTION)
  pooled: { estimate: number; ciLow: number; ciHigh: number } | null; // DISPLAY scale
  heterogeneity: { i2: number; q: number; df: number; p: number } | null; // null when k < 2
  egger: { p: number; k: number } | null; // null when k < 3 or degenerate
  k: number; // number of pooled studies
  totalN: number | null; // sum of studies[].n; null if ANY pooled study's n unknown
  studies: GradeStudyInput[]; // pooled studies only
  startingLevel: "HIGH" | "LOW";
}

export interface DomainDraft {
  domain: GradeDomainId;
  judgment: GradeJudgmentId;
  rationale: string; // templated prose WITH the actual numbers
  requiresReview: boolean;
  metrics: Record<string, unknown>; // JSON-safe, all floats rounded via round4()
}

export interface GradeDraft {
  ratings: DomainDraft[];
  points: number;
  certainty: GradeCertaintyId;
}
