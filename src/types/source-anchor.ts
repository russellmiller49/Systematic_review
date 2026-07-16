// Source anchor v2 — the durable "where in the PDF" record stored on
// ExtractionSuggestion.sourceAnchor / ExtractionValue.sourceAnchor (Json columns).
//
// CONTRACT:
// - charStart/charEnd are offsets into the NORMALIZED text (normalizeForMatch from
//   src/lib/quote-match.ts) of OUR stored FullTextPage text for `page` — never into
//   pdf.js-version-coupled geometry or raw extraction output. `textVersion` records
//   which FullTextFile.textVersion those offsets were computed against; when the file
//   is re-extracted (textVersion bumps) offsets may be stale and consumers should fall
//   back to re-matching the quote.
// - `quads` is a reserved optional slot for page-space highlight geometry (arrays of
//   8 numbers, PDF user-space). Nothing produces it today; validators tolerate it so
//   future writers don't need a v3.
// - Legacy v1 anchors ({ fileId, page }) predate this module; parseSourceAnchor
//   normalizes them to a v2 "page-only" anchor (or null when page is missing).

import { z } from "zod";

export const ANCHOR_MATCH_QUALITIES = ["exact", "fuzzy", "page-only", "selection"] as const;

export type AnchorMatchQuality = (typeof ANCHOR_MATCH_QUALITIES)[number];

export interface SourceAnchorV2 {
  v: 2;
  fileId: string;
  page: number; // 1-based
  charStart?: number;
  charEnd?: number;
  quads?: number[][]; // reserved: page-space quad points (8 numbers each)
  matchQuality: AnchorMatchQuality;
  matchScore?: number; // 0..1 (1 for exact)
  textVersion?: number; // FullTextFile.textVersion the offsets refer to
}

// Input-validation schema for client-supplied anchors (upsertValue et al.). Offsets
// must come as a well-formed pair; a lone endpoint is meaningless.
export const sourceAnchorV2Schema = z
  .object({
    v: z.literal(2),
    fileId: z.string().min(1),
    page: z.number().int().min(1),
    charStart: z.number().int().min(0).optional(),
    charEnd: z.number().int().min(1).optional(),
    quads: z.array(z.array(z.number()).length(8)).max(200).optional(),
    matchQuality: z.enum(ANCHOR_MATCH_QUALITIES),
    matchScore: z.number().min(0).max(1).optional(),
    textVersion: z.number().int().min(0).optional(),
  })
  .refine(
    (a) =>
      (a.charStart === undefined) === (a.charEnd === undefined) &&
      (a.charStart === undefined || a.charEnd === undefined || a.charEnd > a.charStart),
    { message: "charStart/charEnd must be provided together with charEnd > charStart" },
  );

// ---------------------------------------------------------------------------
// Reading anchors back off Json columns
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isValidOffsetPair(charStart: unknown, charEnd: unknown): boolean {
  return (
    typeof charStart === "number" &&
    Number.isInteger(charStart) &&
    charStart >= 0 &&
    typeof charEnd === "number" &&
    Number.isInteger(charEnd) &&
    charEnd > charStart
  );
}

function isQuality(value: unknown): value is AnchorMatchQuality {
  return (
    typeof value === "string" && (ANCHOR_MATCH_QUALITIES as readonly string[]).includes(value)
  );
}

// Tolerant, dependency-light reader for stored anchors (Json columns hold whatever an
// older writer produced). Accepts v2 anchors and legacy v1 `{ fileId, page }` rows —
// legacy anchors normalize to a v2 "page-only" anchor. Anything else (including a
// legacy anchor whose page is null/absent) returns null. Deliberately NOT the zod
// schema: this runs in client components too and must not drag zod into the bundle.
export function parseSourceAnchor(value: unknown): SourceAnchorV2 | null {
  if (!isRecord(value)) return null;
  const fileId = value.fileId;
  if (typeof fileId !== "string" || fileId.length === 0) return null;
  const page = value.page;
  if (typeof page !== "number" || !Number.isInteger(page) || page < 1) return null;

  // Legacy v1: { fileId, page } with no version tag → page-only.
  if (value.v === undefined) {
    return { v: 2, fileId, page, matchQuality: "page-only" };
  }
  if (value.v !== 2 || !isQuality(value.matchQuality)) return null;

  const anchor: SourceAnchorV2 = { v: 2, fileId, page, matchQuality: value.matchQuality };
  if (isValidOffsetPair(value.charStart, value.charEnd)) {
    anchor.charStart = value.charStart as number;
    anchor.charEnd = value.charEnd as number;
  }
  if (typeof value.matchScore === "number" && value.matchScore >= 0 && value.matchScore <= 1) {
    anchor.matchScore = value.matchScore;
  }
  if (
    typeof value.textVersion === "number" &&
    Number.isInteger(value.textVersion) &&
    value.textVersion >= 0
  ) {
    anchor.textVersion = value.textVersion;
  }
  if (
    Array.isArray(value.quads) &&
    value.quads.every(
      (q): q is number[] =>
        Array.isArray(q) && q.length === 8 && q.every((n) => typeof n === "number"),
    )
  ) {
    anchor.quads = value.quads;
  }
  return anchor;
}
