// Pure prompt builder for AI title/abstract prescreening. No I/O — unit-tested.
// Bump SCREENING_PROMPT_VERSION whenever the wording or schema changes; the version is
// stored on every run and suggestion row.

import type { BuiltPrompt } from "../types";
import { SCREENING_JSON_SCHEMA } from "../schemas";

export const SCREENING_PROMPT_VERSION = "screening-v1";

export interface ScreeningProtocolContext {
  reviewQuestion: string | null;
  population: string | null;
  intervention: string | null;
  comparator: string | null;
  outcomesNarrative: string | null;
  studyDesigns: string[];
  setting: string | null;
  dateRestrictionFrom: number | null;
  dateRestrictionTo: number | null;
  languageRestrictions: string[];
  picoQuestions: {
    question: string;
    population: string | null;
    intervention: string | null;
    comparator: string | null;
    outcome: string | null;
  }[];
  inclusionCriteria: { category: string | null; text: string }[];
  exclusionCriteria: { category: string | null; text: string }[];
}

export interface ScreeningCitationContext {
  title: string;
  abstract: string | null;
  year: number | null;
  journal: string | null;
}

const SYSTEM = `You are screening titles and abstracts for a systematic review. Judge each citation strictly against the review protocol provided by the user.

Scoring semantics:
- score is the likelihood (0–100) that this citation would be INCLUDED at the title/abstract stage: 0 means it certainly fails the eligibility criteria, 100 means it certainly meets them.
- decision INCLUDE: the title/abstract indicates the study meets the eligibility criteria.
- decision EXCLUDE: the title/abstract clearly violates at least one criterion — name it in the rationale.
- decision MAYBE: the title/abstract does not give enough information to tell. Title/abstract screening errs toward inclusion: when genuinely uncertain, prefer MAYBE over EXCLUDE so the full text can settle it.
- rationale: one to three sentences naming the decisive criteria. Do not restate the abstract.

Judge only what the citation reports. Do not use outside knowledge about the study, and do not penalize an abstract for omitting details abstracts rarely contain.`;

function section(title: string, body: string | null | undefined): string[] {
  const trimmed = body?.trim();
  return trimmed ? [`${title}: ${trimmed}`] : [];
}

function criterionLines(criteria: { category: string | null; text: string }[]): string[] {
  return criteria.map(
    (c, i) => `${i + 1}. ${c.category ? `[${c.category}] ` : ""}${c.text.trim()}`,
  );
}

export function buildScreeningPrompt(input: {
  protocol: ScreeningProtocolContext;
  citation: ScreeningCitationContext;
}): BuiltPrompt {
  const { protocol, citation } = input;
  const lines: string[] = ["# Review protocol", ""];

  lines.push(...section("Review question", protocol.reviewQuestion));
  lines.push(...section("Population", protocol.population));
  lines.push(...section("Intervention/exposure", protocol.intervention));
  lines.push(...section("Comparator", protocol.comparator));
  lines.push(...section("Outcomes", protocol.outcomesNarrative));
  if (protocol.studyDesigns.length > 0) {
    lines.push(`Eligible study designs: ${protocol.studyDesigns.join(", ")}`);
  }
  lines.push(...section("Setting", protocol.setting));
  if (protocol.dateRestrictionFrom !== null || protocol.dateRestrictionTo !== null) {
    lines.push(
      `Publication years: ${protocol.dateRestrictionFrom ?? "any"} to ${protocol.dateRestrictionTo ?? "any"}`,
    );
  }
  if (protocol.languageRestrictions.length > 0) {
    lines.push(`Language restrictions: ${protocol.languageRestrictions.join(", ")}`);
  }

  if (protocol.picoQuestions.length > 0) {
    lines.push("", "## PICO questions");
    for (const q of protocol.picoQuestions) {
      const parts = [
        q.question.trim(),
        q.population ? `P: ${q.population}` : null,
        q.intervention ? `I: ${q.intervention}` : null,
        q.comparator ? `C: ${q.comparator}` : null,
        q.outcome ? `O: ${q.outcome}` : null,
      ].filter(Boolean);
      lines.push(`- ${parts.join(" | ")}`);
    }
  }

  lines.push("", "## Inclusion criteria");
  lines.push(
    ...(protocol.inclusionCriteria.length > 0
      ? criterionLines(protocol.inclusionCriteria)
      : ["(none recorded)"]),
  );
  lines.push("", "## Exclusion criteria");
  lines.push(
    ...(protocol.exclusionCriteria.length > 0
      ? criterionLines(protocol.exclusionCriteria)
      : ["(none recorded)"]),
  );

  lines.push("", "# Citation to screen", "");
  lines.push(`Title: ${citation.title.trim()}`);
  if (citation.year !== null) lines.push(`Year: ${citation.year}`);
  if (citation.journal?.trim()) lines.push(`Journal: ${citation.journal.trim()}`);
  const abstract = citation.abstract?.trim();
  if (abstract) {
    lines.push("", "Abstract:", abstract);
  } else {
    lines.push("", "No abstract is available — judge from the title alone (this alone is not a reason to exclude).");
  }

  return { system: SYSTEM, user: lines.join("\n"), jsonSchema: SCREENING_JSON_SCHEMA };
}
