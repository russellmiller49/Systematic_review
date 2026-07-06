// NBIB / PubMed MEDLINE parser. Pure, never throws — malformed chunks become error rows.
// Tags are up to 4 chars padded then "- " (e.g. "PMID- ", "TI  - ", "FAU - ");
// continuation lines start with 6 spaces. Records are separated by blank lines.
import {
  normalizeDoi,
  normalizePmid,
  parseAuthorName,
} from "@/server/services/citations/normalize";
import {
  emptyFileResult,
  extractYear,
  preprocess,
  type ParsedRecord,
  type ParseResult,
  type ParseRowError,
} from "./types";

const TAG_RE = /^([A-Z][A-Z0-9]{0,3})\s*- (.*)$/;
const CONTINUATION_RE = /^ {6}(.*)$/;

export function parseNbib(content: string): ParseResult {
  const text = preprocess(content);
  if (text.trim().length === 0) return emptyFileResult();

  const records: ParsedRecord[] = [];
  const errors: ParseRowError[] = [];

  const chunks = text
    .split(/\n\s*\n/)
    .map((c) => c.replace(/^\n+|\n+$/g, ""))
    .filter((c) => c.trim().length > 0);

  chunks.forEach((chunk, idx) => {
    const rowNumber = idx + 1;
    const tags = new Map<string, string[]>();
    let lastTag: string | null = null;

    for (const line of chunk.split("\n")) {
      const tagMatch = line.match(TAG_RE);
      if (tagMatch) {
        const tag = tagMatch[1]!;
        const values = tags.get(tag) ?? [];
        values.push(tagMatch[2] ?? "");
        tags.set(tag, values);
        lastTag = tag;
        continue;
      }
      const contMatch = line.match(CONTINUATION_RE);
      if (contMatch && lastTag) {
        const values = tags.get(lastTag)!;
        const i = values.length - 1;
        values[i] = `${values[i] ?? ""} ${contMatch[1]!.trim()}`.trim();
      }
      // Anything else is tolerated noise within the record.
    }

    if (tags.size === 0) {
      errors.push({
        rowNumber,
        message: "Unrecognized NBIB content (no MEDLINE tags found)",
        rawChunk: chunk,
      });
      return;
    }

    const title = joined(tags, "TI");
    if (!title) {
      errors.push({
        rowNumber,
        message: "NBIB record is missing a title (TI)",
        rawChunk: chunk,
      });
      return;
    }

    const fullAuthors = tags.get("FAU") ?? [];
    const shortAuthors = tags.get("AU") ?? [];
    const authors =
      fullAuthors.length > 0
        ? fullAuthors
            .map((a) => a.trim())
            .filter((a) => a.length > 0)
            .map(parseAuthorName)
        : shortAuthors
            .map((a) => a.trim())
            .filter((a) => a.length > 0)
            .map(parseMedlineShortAuthor);

    records.push({
      title,
      authors,
      year: extractYear(first(tags, "DP")),
      journal: first(tags, "JT") ?? first(tags, "TA"),
      volume: first(tags, "VI"),
      issue: first(tags, "IP"),
      pages: first(tags, "PG"),
      abstract: joined(tags, "AB"),
      doi: extractDoi(tags) ?? undefined,
      pmid: normalizePmid(first(tags, "PMID") ?? null) ?? undefined,
      language: first(tags, "LA"),
      rawChunk: chunk,
      rowNumber,
    });
  });

  return { records, errors };
}

// MEDLINE AU values are "Family Initials" ("Nguyen THL", "de Vries JW") — the trailing
// all-caps token is the initials, everything before it the family name.
function parseMedlineShortAuthor(raw: string) {
  const m = raw.match(/^(.+?)\s+([A-Z]{1,4}(?:-[A-Z]{1,4})?)$/);
  if (m) return { family: m[1]!, given: m[2]!, raw };
  return parseAuthorName(raw);
}

function first(tags: Map<string, string[]>, tag: string): string | undefined {
  const value = tags.get(tag)?.find((v) => v.trim().length > 0);
  return value?.trim();
}

function joined(tags: Map<string, string[]>, tag: string): string | undefined {
  const values = (tags.get(tag) ?? []).map((v) => v.trim()).filter((v) => v.length > 0);
  return values.length > 0 ? values.join(" ") : undefined;
}

// DOI lives in LID or AID values carrying a "[doi]" marker: "10.1056/NEJMoa123 [doi]".
function extractDoi(tags: Map<string, string[]>): string | null {
  const candidates = [...(tags.get("LID") ?? []), ...(tags.get("AID") ?? [])];
  for (const value of candidates) {
    const m = value.match(/^(.*)\s*\[doi\]\s*$/i);
    if (m) {
      const doi = normalizeDoi(m[1]!.trim());
      if (doi) return doi;
    }
  }
  return null;
}
