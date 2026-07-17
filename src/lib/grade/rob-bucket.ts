// Pure classifier: map one judgment of a risk-of-bias tool's judgmentScale JSON onto the
// coarse buckets the GRADE RISK_OF_BIAS roll-up uses.
//
// Algorithm (in order):
// 1. Parse scale entries { value, label, color?, severity? }. Malformed input is
//    tolerated and ultimately maps to { bucket: "unclear", certain: false }.
// 2. Match the entry whose value === judgmentValue (fallback: case-insensitive label
//    match). No entry -> { "unclear", certain: false }.
// 3. Informational values FIRST: value or label matching
//    /unclear|no.?information|not.?applicable|unknown/i -> { "unclear", certain: true }.
// 4. Severity is authoritative only when EVERY non-informational entry has a distinct,
//    finite numeric severity and at least two such entries exist. Rank ascending: minimum
//    -> "low", normalized rank in the upper third -> "high", the rest -> "moderate".
// 5. Partial, duplicate, missing or malformed severity data never falls back to judgment
//    keywords: it maps to { "unclear", certain: false } for explicit human review.
//
// This maps every built-in tool correctly: RoB 2 (low/some_concerns/high), ROBINS-I
// (serious/critical -> high, no_information -> unclear), QUADAS-2, NOS (good/fair/poor),
// JBI, AMSTAR 2 (high-confidence -> low via min severity, critically_low -> high) and
// the generic tool (unclear/not_applicable -> unclear).

import type { RobBucket } from "./types";

const INFORMATIONAL_RE = /unclear|no.?information|not.?applicable|unknown/i;

interface ScaleEntry {
  value: string;
  label: string;
  severity: number | null;
}

interface ParsedScale {
  entries: ScaleEntry[];
  malformed: boolean;
}

function parseScale(scale: unknown): ParsedScale {
  if (!Array.isArray(scale)) return { entries: [], malformed: true };
  const entries: ScaleEntry[] = [];
  const values = new Set<string>();
  let malformed = false;
  for (const raw of scale) {
    if (typeof raw !== "object" || raw === null) {
      malformed = true;
      continue;
    }
    const { value, label, severity } = raw as Record<string, unknown>;
    if (
      typeof value !== "string" ||
      value.trim().length === 0 ||
      typeof label !== "string" ||
      label.trim().length === 0 ||
      values.has(value)
    ) {
      malformed = true;
      continue;
    }
    values.add(value);
    let parsedSeverity: number | null = null;
    if (severity !== undefined) {
      if (typeof severity === "number" && Number.isFinite(severity)) {
        parsedSeverity = severity;
      }
    }
    entries.push({
      value,
      label,
      severity: parsedSeverity,
    });
  }
  return { entries, malformed };
}

function isInformational(entry: ScaleEntry): boolean {
  return INFORMATIONAL_RE.test(entry.value) || INFORMATIONAL_RE.test(entry.label);
}

/** Classify one resolved judgment value against its tool's judgmentScale JSON. */
export function classifyRobJudgment(
  scale: unknown,
  judgmentValue: string,
): { bucket: RobBucket; certain: boolean } {
  const { entries, malformed } = parseScale(scale);
  const loweredValue = judgmentValue.toLowerCase();
  const entry =
    entries.find((e) => e.value === judgmentValue) ??
    entries.find((e) => e.label.toLowerCase() === loweredValue);
  if (!entry) return { bucket: "unclear", certain: false };

  if (isInformational(entry)) return { bucket: "unclear", certain: true };

  const ranked = entries.filter((candidate) => !isInformational(candidate));
  if (
    malformed ||
    ranked.length < 2 ||
    ranked.some((candidate) => candidate.severity === null)
  ) {
    return { bucket: "unclear", certain: false };
  }

  const severities = ranked.map((candidate) => candidate.severity!);
  if (new Set(severities).size !== severities.length) {
    return { bucket: "unclear", certain: false };
  }
  severities.sort((a, b) => a - b);
  const rank = severities.indexOf(entry.severity!);
  if (rank === 0) return { bucket: "low", certain: true };
  if (rank / (severities.length - 1) >= 2 / 3) {
    return { bucket: "high", certain: true };
  }
  return { bucket: "moderate", certain: true };
}
