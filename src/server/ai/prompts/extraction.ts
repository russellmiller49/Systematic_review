// Pure prompt builder for AI full-text extraction. No I/O — unit-tested.
// The per-type output rules mirror validateFieldValue (extraction/validation.ts) so a
// compliant answer passes server-side validation. Bump EXTRACTION_PROMPT_VERSION whenever
// the wording or schema changes.

import type { BuiltPrompt } from "../types";
import type { PromptField } from "../schemas";
import { extractionJsonSchemaFor } from "../schemas";

export const EXTRACTION_PROMPT_VERSION = "extraction-v1";

const SYSTEM = `You are extracting data from a study report (PDF) for a systematic review. Fill the requested fields using only what this document reports.

Rules:
- Never guess or infer beyond the document. If an item is not reported, return found: false with value: null.
- For every found value, include a short verbatim sourceQuote from the document and the 1-based page number of the PDF file where it appears (count PDF pages from 1, not the journal's printed page numbers).
- confidence is your confidence (0 to 1) that the value is correct and correctly located.
- Return exactly one entry per requested field key, matching the key strings exactly.`;

function typeRule(field: PromptField): string {
  switch (field.type) {
    case "TEXT":
      return "value must be a short string";
    case "TEXTAREA":
      return "value must be a string (longer prose is fine)";
    case "NUMBER":
      return "value must be a single finite number — digits only, no units, commas, ranges, or percent signs";
    case "DATE":
      return "value must be a complete calendar date string in yyyy-mm-dd format; if the document reports only a month or year, return found: false";
    case "BOOLEAN":
      return "value must be true or false";
    case "SINGLE_SELECT":
      return `value must be exactly one of these option values (use the value string, not the label): ${field.options.map((o) => JSON.stringify(o.value)).join(", ")}`;
    case "MULTI_SELECT":
      return `value must be a non-empty array of distinct option values from (use the value strings, not the labels): ${field.options.map((o) => JSON.stringify(o.value)).join(", ")}`;
  }
}

function fieldLine(field: PromptField): string {
  const parts = [
    `- key ${JSON.stringify(field.key)}: ${field.label.trim()} (${field.type}${field.required ? ", required by the form" : ""})`,
  ];
  if (field.section?.trim()) parts.push(`  Section: ${field.section.trim()}`);
  if (field.helpText?.trim()) parts.push(`  Guidance: ${field.helpText.trim()}`);
  if (field.type === "SINGLE_SELECT" || field.type === "MULTI_SELECT") {
    const options = field.options
      .map((o) => `${JSON.stringify(o.value)} = ${o.label}`)
      .join("; ");
    parts.push(`  Options: ${options}`);
  }
  parts.push(`  Rule: ${typeRule(field)}`);
  return parts.join("\n");
}

export function buildExtractionPrompt(input: {
  studyLabel: string;
  fields: PromptField[];
}): BuiltPrompt {
  const lines: string[] = [
    `Study: ${input.studyLabel.trim()}`,
    "",
    "Extract the following fields from the attached document:",
    "",
  ];
  for (const field of input.fields) {
    lines.push(fieldLine(field));
  }
  lines.push(
    "",
    "Remember: one entry per field key; found: false with value: null for anything the document does not report; a 'required by the form' marker does NOT mean you may guess — it only tells you the field matters to the reviewers.",
  );

  return {
    system: SYSTEM,
    user: lines.join("\n"),
    jsonSchema: extractionJsonSchemaFor(input.fields),
  };
}
