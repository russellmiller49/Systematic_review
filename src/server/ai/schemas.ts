// Wire-level JSON Schemas sent to providers + zod parsing/clamping of what comes back.
// The wire schemas stay permissive where providers can't enforce constraints (numeric
// bounds, per-field value types); authoritative validation happens server-side on ingest
// (parse* here, plus validateFieldValue for extraction values).

import { z } from "zod";
import type { FieldType } from "@prisma/client";
import type { FieldOption } from "@/server/services/extraction/validation";

// ---------------------------------------------------------------------------
// Screening
// ---------------------------------------------------------------------------

export const SCREENING_JSON_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: {
    score: {
      type: "integer",
      description:
        "Likelihood of inclusion from 0 (certainly excluded) to 100 (certainly included)",
    },
    decision: {
      type: "string",
      enum: ["INCLUDE", "EXCLUDE", "MAYBE"],
      description: "Suggested title/abstract screening decision",
    },
    rationale: {
      type: "string",
      description: "One to three sentences naming the decisive eligibility criteria",
    },
  },
  required: ["score", "decision", "rationale"],
  additionalProperties: false,
};

const screeningResultSchema = z.object({
  score: z.number(),
  decision: z.enum(["INCLUDE", "EXCLUDE", "MAYBE"]),
  rationale: z.string(),
});

export interface ParsedScreeningResult {
  score: number; // integer, clamped to 0–100
  suggestedDecision: "INCLUDE" | "EXCLUDE" | "MAYBE";
  rationale: string;
}

const MAX_RATIONALE_CHARS = 2000;

// Throws (ZodError) on shape mismatch — callers treat that as a failed batch item.
export function parseScreeningResult(json: unknown): ParsedScreeningResult {
  const parsed = screeningResultSchema.parse(json);
  if (!Number.isFinite(parsed.score)) {
    throw new Error("Screening score is not a finite number");
  }
  return {
    score: Math.min(100, Math.max(0, Math.round(parsed.score))),
    suggestedDecision: parsed.decision,
    rationale: parsed.rationale.trim().slice(0, MAX_RATIONALE_CHARS),
  };
}

// ---------------------------------------------------------------------------
// Extraction
// ---------------------------------------------------------------------------

// The template-field shape the prompt builder and schema builder consume.
export interface PromptField {
  id: string;
  key: string;
  label: string;
  type: FieldType;
  required: boolean;
  section: string | null;
  helpText: string | null;
  options: FieldOption[];
}

// One entry per field key. `value` is deliberately loose on the wire (string | number |
// boolean | string[] | null); validateFieldValue applies the authoritative per-type rules.
// Every property is listed in `required` (with null unions) because OpenAI strict mode
// demands it; the other providers accept the same schema.
export function extractionJsonSchemaFor(fields: PromptField[]): Record<string, unknown> {
  return {
    type: "object",
    properties: {
      fields: {
        type: "array",
        description: "Exactly one entry per requested field key",
        items: {
          type: "object",
          properties: {
            key: { type: "string", enum: fields.map((f) => f.key) },
            found: {
              type: "boolean",
              description: "false when the document does not report this item",
            },
            value: {
              description: "The extracted value per the field's typing rules; null when found is false",
              anyOf: [
                { type: "string" },
                { type: "number" },
                { type: "boolean" },
                { type: "array", items: { type: "string" } },
                { type: "null" },
              ],
            },
            sourceQuote: {
              anyOf: [{ type: "string" }, { type: "null" }],
              description: "Short verbatim quote from the document supporting the value",
            },
            pageNumber: {
              anyOf: [{ type: "integer" }, { type: "null" }],
              description: "1-based page of the PDF file where the quote appears",
            },
            confidence: {
              anyOf: [{ type: "number" }, { type: "null" }],
              description: "Confidence in the extracted value, from 0 to 1",
            },
          },
          required: ["key", "found", "value", "sourceQuote", "pageNumber", "confidence"],
          additionalProperties: false,
        },
      },
    },
    required: ["fields"],
    additionalProperties: false,
  };
}

const extractionItemSchema = z.object({
  key: z.string(),
  found: z.boolean(),
  value: z.unknown().optional(),
  sourceQuote: z.string().nullable().optional(),
  pageNumber: z.number().nullable().optional(),
  confidence: z.number().nullable().optional(),
});

const extractionResultSchema = z.object({
  fields: z.array(extractionItemSchema),
});

export interface ParsedExtractionField {
  key: string;
  found: boolean;
  value: unknown; // null when not found
  sourceQuote: string | null;
  pageNumber: number | null; // integer >= 1
  confidence: number | null; // clamped to 0–1
}

const MAX_QUOTE_CHARS = 2000;

// Throws (ZodError) on envelope mismatch. Dedupes by key (first entry wins) and drops
// nothing else — unknown keys are filtered later against the template's field list.
export function parseExtractionResult(json: unknown): ParsedExtractionField[] {
  const parsed = extractionResultSchema.parse(json);
  const byKey = new Map<string, ParsedExtractionField>();
  for (const item of parsed.fields) {
    if (byKey.has(item.key)) continue;
    const pageNumber =
      typeof item.pageNumber === "number" && Number.isFinite(item.pageNumber)
        ? Math.max(1, Math.round(item.pageNumber))
        : null;
    const confidence =
      typeof item.confidence === "number" && Number.isFinite(item.confidence)
        ? Math.min(1, Math.max(0, item.confidence))
        : null;
    const sourceQuote =
      typeof item.sourceQuote === "string" && item.sourceQuote.trim() !== ""
        ? item.sourceQuote.trim().slice(0, MAX_QUOTE_CHARS)
        : null;
    byKey.set(item.key, {
      key: item.key,
      found: item.found,
      value: item.found ? (item.value === undefined ? null : item.value) : null,
      sourceQuote,
      pageNumber,
      confidence,
    });
  }
  return [...byKey.values()];
}
