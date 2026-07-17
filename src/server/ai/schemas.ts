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

// ---------------------------------------------------------------------------
// Risk of bias
// ---------------------------------------------------------------------------

// The tool-structure shape the RoB prompt and schema builders consume.
export interface RobPromptQuestion {
  id: string;
  text: string;
  guidance: string | null;
  allowedAnswers: string[];
}

export interface RobPromptDomain {
  id: string;
  name: string;
  guidance: string | null;
  questions: RobPromptQuestion[];
}

// One entry per domain id. The `answer` enum is the UNION of allowed answers across the
// tool (per-question enums would need one oneOf branch per question — 34 for ROBINS-I —
// which risks provider strict-mode limits); authoritative per-question validation happens
// on ingest. Empty enums are illegal JSON Schema, so tools without questions fall back to
// plain strings.
export function robJsonSchemaFor(
  scaleValues: string[],
  domains: RobPromptDomain[],
): Record<string, unknown> {
  const questionIds = domains.flatMap((d) => d.questions.map((q) => q.id));
  const answerUnion = [...new Set(domains.flatMap((d) => d.questions.flatMap((q) => q.allowedAnswers)))];
  const nullable = (schema: Record<string, unknown>) => ({ anyOf: [schema, { type: "null" }] });
  return {
    type: "object",
    properties: {
      domains: {
        type: "array",
        description: "Exactly one entry per domain id",
        items: {
          type: "object",
          properties: {
            domainId: { type: "string", enum: domains.map((d) => d.id) },
            assessable: {
              type: "boolean",
              description: "false when the domain cannot be assessed from this document",
            },
            judgment: {
              ...nullable(
                scaleValues.length > 0
                  ? { type: "string", enum: scaleValues }
                  : { type: "string" },
              ),
              description:
                "Suggested domain judgment using the tool's scale value strings; null when not assessable",
            },
            rationale: {
              type: "string",
              description: "One to three sentences supporting the judgment",
            },
            confidence: {
              ...nullable({ type: "number" }),
              description: "Confidence in the suggested judgment, from 0 to 1",
            },
            quotes: {
              type: "array",
              description: "Up to three short verbatim quotes supporting the judgment",
              items: {
                type: "object",
                properties: {
                  text: { type: "string" },
                  page: {
                    ...nullable({ type: "integer" }),
                    description: "1-based page of the PDF file where the quote appears",
                  },
                },
                required: ["text", "page"],
                additionalProperties: false,
              },
            },
            answers: {
              type: "array",
              description: "One entry per signaling question id in this domain",
              items: {
                type: "object",
                properties: {
                  questionId:
                    questionIds.length > 0
                      ? { type: "string", enum: questionIds }
                      : { type: "string" },
                  answer:
                    answerUnion.length > 0
                      ? { type: "string", enum: answerUnion }
                      : { type: "string" },
                  quote: nullable({ type: "string" }),
                  page: nullable({ type: "integer" }),
                },
                required: ["questionId", "answer", "quote", "page"],
                additionalProperties: false,
              },
            },
          },
          required: ["domainId", "assessable", "judgment", "rationale", "confidence", "quotes", "answers"],
          additionalProperties: false,
        },
      },
    },
    required: ["domains"],
    additionalProperties: false,
  };
}

const robQuoteSchema = z.object({
  text: z.string(),
  page: z.number().nullable().optional(),
});

const robAnswerSchema = z.object({
  questionId: z.string(),
  answer: z.string(),
  quote: z.string().nullable().optional(),
  page: z.number().nullable().optional(),
});

const robDomainItemSchema = z.object({
  domainId: z.string(),
  assessable: z.boolean(),
  judgment: z.string().nullable().optional(),
  rationale: z.string().nullable().optional(),
  confidence: z.number().nullable().optional(),
  quotes: z.array(robQuoteSchema).optional(),
  answers: z.array(robAnswerSchema).optional(),
});

const robResultSchema = z.object({
  domains: z.array(robDomainItemSchema),
});

export interface ParsedRobQuote {
  text: string;
  page: number | null; // integer >= 1
}

export interface ParsedRobAnswer {
  questionId: string;
  answer: string;
  quote: string | null;
  page: number | null;
}

export interface ParsedRobDomain {
  domainId: string;
  assessable: boolean;
  judgment: string | null;
  rationale: string;
  confidence: number | null; // clamped to 0–1
  quotes: ParsedRobQuote[];
  answers: ParsedRobAnswer[];
}

const MAX_ROB_RATIONALE_CHARS = 4000;
const MAX_ROB_QUOTE_CHARS = 1500;
const MAX_ROB_ANSWER_QUOTE_CHARS = 500;
const MAX_ROB_QUOTES_PER_DOMAIN = 3;

function clampPage(page: number | null | undefined): number | null {
  return typeof page === "number" && Number.isFinite(page) ? Math.max(1, Math.round(page)) : null;
}

// Throws (ZodError) on envelope mismatch. Dedupes domains and per-domain answers by id
// (first entry wins); unknown ids are filtered later against the tool's structure.
export function parseRobResult(json: unknown): ParsedRobDomain[] {
  const parsed = robResultSchema.parse(json);
  const byDomain = new Map<string, ParsedRobDomain>();
  for (const item of parsed.domains) {
    if (byDomain.has(item.domainId)) continue;
    const quotes: ParsedRobQuote[] = (item.quotes ?? [])
      .filter((q) => q.text.trim() !== "")
      .slice(0, MAX_ROB_QUOTES_PER_DOMAIN)
      .map((q) => ({ text: q.text.trim().slice(0, MAX_ROB_QUOTE_CHARS), page: clampPage(q.page) }));
    const byQuestion = new Map<string, ParsedRobAnswer>();
    for (const answer of item.answers ?? []) {
      if (byQuestion.has(answer.questionId)) continue;
      const quote =
        typeof answer.quote === "string" && answer.quote.trim() !== ""
          ? answer.quote.trim().slice(0, MAX_ROB_ANSWER_QUOTE_CHARS)
          : null;
      byQuestion.set(answer.questionId, {
        questionId: answer.questionId,
        answer: answer.answer,
        quote,
        page: clampPage(answer.page),
      });
    }
    const confidence =
      typeof item.confidence === "number" && Number.isFinite(item.confidence)
        ? Math.min(1, Math.max(0, item.confidence))
        : null;
    byDomain.set(item.domainId, {
      domainId: item.domainId,
      assessable: item.assessable,
      judgment:
        typeof item.judgment === "string" && item.judgment.trim() !== ""
          ? item.judgment.trim()
          : null,
      rationale: (item.rationale ?? "").trim().slice(0, MAX_ROB_RATIONALE_CHARS),
      confidence,
      quotes,
      answers: [...byQuestion.values()],
    });
  }
  return [...byDomain.values()];
}

// ---------------------------------------------------------------------------
// GRADE
// ---------------------------------------------------------------------------

export const GRADE_DOMAIN_IDS = [
  "RISK_OF_BIAS",
  "INCONSISTENCY",
  "INDIRECTNESS",
  "IMPRECISION",
  "PUBLICATION_BIAS",
] as const;

export const GRADE_JUDGMENT_IDS = ["NOT_SERIOUS", "SERIOUS", "VERY_SERIOUS"] as const;

export type GradeDomainName = (typeof GRADE_DOMAIN_IDS)[number];
export type GradeJudgmentName = (typeof GRADE_JUDGMENT_IDS)[number];

// One entry per GRADE certainty domain. Confidence is a plain number on the wire
// (providers can't enforce 0–1 bounds); parseGradeResult clamps on ingest.
export const GRADE_JSON_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: {
    domains: {
      type: "array",
      description: "Exactly one entry per GRADE domain — all five, each exactly once",
      items: {
        type: "object",
        properties: {
          domain: { type: "string", enum: [...GRADE_DOMAIN_IDS] },
          judgment: {
            type: "string",
            enum: [...GRADE_JUDGMENT_IDS],
            description: "Suggested GRADE concern level for this domain",
          },
          rationale: {
            type: "string",
            minLength: 1,
            description: "One to three sentences citing the provided numbers",
          },
          confidence: {
            type: "number",
            description: "Confidence in the suggested judgment, from 0 to 1",
          },
        },
        required: ["domain", "judgment", "rationale", "confidence"],
        additionalProperties: false,
      },
    },
  },
  required: ["domains"],
  additionalProperties: false,
};

// Only the envelope is enforced by zod — item-level validation is authoritative in code so
// malformed items are dropped and counted instead of failing the whole run.
const gradeResultSchema = z.object({
  domains: z.array(z.unknown()),
});

export interface ParsedGradeDomain {
  domain: GradeDomainName;
  judgment: GradeJudgmentName;
  rationale: string;
  confidence: number | null; // clamped to 0–1
}

const MAX_GRADE_RATIONALE_CHARS = 4000;

const GRADE_DOMAIN_SET = new Set<string>(GRADE_DOMAIN_IDS);
const GRADE_JUDGMENT_SET = new Set<string>(GRADE_JUDGMENT_IDS);

// Throws (ZodError) on envelope mismatch — the caller marks the run FAILED. Unknown or
// duplicate domains and invalid judgments are DROPPED and counted in invalidCount (for
// duplicates the first kept occurrence wins).
export function parseGradeResult(json: unknown): {
  domains: ParsedGradeDomain[];
  invalidCount: number;
} {
  const parsed = gradeResultSchema.parse(json);
  const byDomain = new Map<GradeDomainName, ParsedGradeDomain>();
  let invalidCount = 0;
  for (const raw of parsed.domains) {
    const item =
      raw !== null && typeof raw === "object"
        ? (raw as { domain?: unknown; judgment?: unknown; rationale?: unknown; confidence?: unknown })
        : null;
    const domain = typeof item?.domain === "string" ? item.domain : null;
    const judgment = typeof item?.judgment === "string" ? item.judgment : null;
    const rationale =
      typeof item?.rationale === "string"
        ? item.rationale.trim().slice(0, MAX_GRADE_RATIONALE_CHARS)
        : "";
    if (
      domain === null ||
      !GRADE_DOMAIN_SET.has(domain) ||
      judgment === null ||
      !GRADE_JUDGMENT_SET.has(judgment) ||
      rationale.length === 0 ||
      byDomain.has(domain as GradeDomainName)
    ) {
      invalidCount += 1;
      continue;
    }
    const confidence =
      typeof item?.confidence === "number" && Number.isFinite(item.confidence)
        ? Math.min(1, Math.max(0, item.confidence))
        : null;
    byDomain.set(domain as GradeDomainName, {
      domain: domain as GradeDomainName,
      judgment: judgment as GradeJudgmentName,
      rationale,
      confidence,
    });
  }
  return { domains: [...byDomain.values()], invalidCount };
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
