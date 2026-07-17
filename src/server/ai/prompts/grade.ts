// Pure prompt builder for AI GRADE certainty-domain suggestions (Tier 2 prose). No I/O —
// unit-tested. The deterministic Tier-1 draft, the pooled result, and the per-study RoB
// picture are serialized in full so the model only ever restates numbers we computed; it
// never sees raw extraction data. Bump GRADE_PROMPT_VERSION whenever the wording or schema
// changes.

import type { BuiltPrompt } from "../types";
import { GRADE_JSON_SCHEMA } from "../schemas";

export const GRADE_PROMPT_VERSION = "grade-v2";

export const INDIRECTNESS_UNVERIFIABLE_RATIONALE =
  "Study-level population, intervention, comparator, and outcome characteristics were not provided to the AI, so indirectness cannot be verified. Retain no automatic downgrade and require human review against the protocol PICO.";

const SYSTEM = `You are drafting GRADE certainty-of-evidence domain judgments for one outcome of a systematic review. A deterministic rules engine has already produced a first-pass judgment per domain from the pooled statistics; refine or confirm each judgment and write a clearer, better-argued rationale.

Rules:
- Use ONLY the data provided by the user (pooled result, heterogeneity, per-study table, deterministic first pass, protocol/PICO). Never invent, recompute, or estimate numbers that are not given.
- Every rationale must cite the specific given numbers it relies on (e.g. the I2 value, confidence interval bounds, participant totals, study weights).
- Judgments: NOT_SERIOUS (no downgrade), SERIOUS (downgrade one level), VERY_SERIOUS (downgrade two levels).
- INDIRECTNESS: the protocol PICO may be listed, but study-level population, intervention, comparator, and outcome characteristics are NOT provided. Do not infer applicability from study labels, effects, or risk of bias. Always return NOT_SERIOUS and state explicitly that indirectness is unverifiable here and requires human review.
- confidence is your 0-to-1 confidence in the suggested judgment.
- Return every one of the 5 domains (RISK_OF_BIAS, INCONSISTENCY, INDIRECTNESS, IMPRECISION, PUBLICATION_BIAS) exactly once.`;

// Pinned by the Wave-4 contract — the ai-grade service constructs exactly this shape.
export interface GradePromptInput {
  outcome: {
    name: string;
    timepoint: string | null;
    measure: string;
    direction: string;
    groupLabels: { g1: string; g2: string };
  };
  picos: Array<{
    question?: string | null;
    population?: string | null;
    intervention?: string | null;
    comparator?: string | null;
    outcomes?: string | null;
  }>;
  protocolSummary: string | null;
  deterministic: Array<{
    domain: string;
    judgment: string;
    rationale: string;
    requiresReview: boolean;
    metrics: unknown; // stored GradeDomainRating.metrics Json — serialized verbatim
  }>;
  pooledSummary: {
    k: number;
    totalN: number | null;
    estimate: number;
    ciLow: number;
    ciHigh: number;
    i2: number | null; // percent scale; null when k < 2
    model: string;
    measureLabel: string;
  };
  studies: Array<{
    label: string;
    n: number | null;
    effectDisplay: string | null; // preformatted display-scale effect, e.g. "3.00 [1.85, 4.87]"
    robBucket: string;
    robJudgmentLabel: string | null;
  }>;
}

function fmt(x: number): string {
  return String(Number(x.toFixed(4)));
}

function picoLine(pico: GradePromptInput["picos"][number], index: number): string | null {
  const parts = [
    pico.population ? `P: ${pico.population.trim()}` : null,
    pico.intervention ? `I: ${pico.intervention.trim()}` : null,
    pico.comparator ? `C: ${pico.comparator.trim()}` : null,
    pico.outcomes ? `O: ${pico.outcomes.trim()}` : null,
  ].filter((p): p is string => p !== null);
  if (parts.length === 0) return null;
  const question = pico.question?.trim() ? ` (${pico.question.trim()})` : "";
  return `PICO ${index + 1}${question} — ${parts.join(" | ")}`;
}

function studyLine(study: GradePromptInput["studies"][number]): string {
  const parts = [
    study.n !== null ? `n = ${study.n}` : "n unknown",
    study.effectDisplay ? `effect ${study.effectDisplay}` : "effect not estimable",
    `risk of bias: ${
      study.robJudgmentLabel
        ? `${study.robJudgmentLabel} (${study.robBucket})`
        : study.robBucket
    }`,
  ];
  return `- ${study.label.trim()}: ${parts.join("; ")}`;
}

export function buildGradePrompt(input: GradePromptInput): BuiltPrompt {
  const { outcome, pooledSummary: pooled } = input;
  const lines: string[] = ["# Outcome", ""];
  lines.push(`Name: ${outcome.name.trim()}`);
  if (outcome.timepoint?.trim()) lines.push(`Timepoint: ${outcome.timepoint.trim()}`);
  lines.push(
    `Effect measure: ${outcome.measure} (${pooled.measureLabel})`,
    `Direction: ${outcome.direction}`,
    `Groups: ${outcome.groupLabels.g1} vs ${outcome.groupLabels.g2}`,
  );

  lines.push("", "# Protocol context", "");
  if (input.protocolSummary?.trim()) lines.push(input.protocolSummary.trim());
  const pico = input.picos
    .map((entry, index) => picoLine(entry, index))
    .filter((line): line is string => line !== null);
  lines.push(...pico);
  if (!input.protocolSummary?.trim() && pico.length === 0) {
    lines.push(
      "No protocol PICO is recorded — applicability cannot be verified; say so in the indirectness rationale.",
    );
  }
  lines.push(
    "Study-level PICO characteristics are not included. INDIRECTNESS must remain NOT_SERIOUS as a human-review placeholder; do not claim the pooled studies match any PICO.",
  );

  lines.push(
    "",
    "# Pooled result (display scale)",
    "",
    `Model: ${pooled.model}; k = ${pooled.k} pooled ${pooled.k === 1 ? "study" : "studies"}; total participants: ${
      pooled.totalN !== null ? pooled.totalN : "unknown"
    }`,
    `${pooled.measureLabel}: ${fmt(pooled.estimate)} [${fmt(pooled.ciLow)}, ${fmt(pooled.ciHigh)}]`,
    pooled.i2 !== null ? `I2 = ${fmt(pooled.i2)}%` : "I2 not assessable (fewer than 2 studies)",
  );

  lines.push("", "# Pooled studies", "");
  lines.push(...input.studies.map(studyLine));

  lines.push("", "# Deterministic first pass", "");
  for (const rating of input.deterministic) {
    lines.push(
      `## ${rating.domain} — ${rating.judgment}${rating.requiresReview ? " (flagged for human review)" : ""}`,
      `Rationale: ${rating.rationale.trim()}`,
      `Metrics: ${JSON.stringify(rating.metrics ?? {})}`,
      "",
    );
  }

  lines.push(
    "Remember: use only the numbers above, cite them in every rationale, and return all 5 domains exactly once.",
  );

  return { system: SYSTEM, user: lines.join("\n"), jsonSchema: GRADE_JSON_SCHEMA };
}
