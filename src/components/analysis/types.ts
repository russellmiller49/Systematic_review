// Shared client-side types + helpers for the analysis (meta-analysis) page.
// Interfaces mirror ONLY what the analysis API returns (outcome CRUD, mappings,
// computed results); stats shapes mirror the stats-lib display contract. Nothing
// here is authoritative — the server recomputes and re-validates everything.

import { ApiError } from "@/lib/api";

// --- Outcomes ------------------------------------------------------------------

export type EffectMeasure = "RR" | "OR" | "RD" | "MD" | "SMD";
export type EffectDirection = "HIGHER_IS_BETTER" | "LOWER_IS_BETTER";
export type PoolingModel = "FIXED" | "RANDOM";

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
  groupLabels: { g1: string; g2: string };
  rows: AnalysisResultRow[];
  pooled: { fixed: PooledEstimate | null; random: PooledEstimate | null };
  heterogeneity: Heterogeneity | null;
  scale: "log" | "linear";
  nullValue: number;
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
};

// Ordered options for the create dialog's measure select.
export const MEASURE_OPTIONS: { value: EffectMeasure; label: string }[] = [
  { value: "RR", label: "Risk ratio" },
  { value: "OR", label: "Odds ratio" },
  { value: "RD", label: "Risk difference" },
  { value: "MD", label: "Mean difference" },
  { value: "SMD", label: "Std. mean difference (Hedges g)" },
];

const BINARY_MEASURES: readonly EffectMeasure[] = ["RR", "OR", "RD"];

export function isBinaryMeasure(measure: EffectMeasure): boolean {
  return BINARY_MEASURES.includes(measure);
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

export function resolveGroupLabels(labels: GroupLabels | null | undefined): {
  g1: string;
  g2: string;
} {
  return { g1: labels?.g1 || "Group 1", g2: labels?.g2 || "Group 2" };
}

const ROLE_SUFFIX_LABELS: Record<string, string> = {
  EVENTS: "events",
  TOTAL: "total",
  MEAN: "mean",
  SD: "SD",
  N: "n",
};

/** "G1_EVENTS" + {g1: "Stent"} → "Stent events"; unknown roles fall back to the raw key. */
export function roleLabel(role: string, groups: { g1: string; g2: string }): string {
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
