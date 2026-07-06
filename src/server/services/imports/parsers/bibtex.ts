// BibTeX parser. Pure, never throws — malformed entries become error rows.
// Handles { .. } and " .. " field values, nested braces, and "and"-separated authors.
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

// Entry types that never carry citation data. Text between entries is a comment per BibTeX.
const NON_RECORD_TYPES = new Set(["comment", "preamble", "string"]);

export function parseBibtex(content: string): ParseResult {
  const text = preprocess(content);
  if (text.trim().length === 0) return emptyFileResult();

  const records: ParsedRecord[] = [];
  const errors: ParseRowError[] = [];
  let rowNumber = 0;
  let i = 0;

  while (i < text.length) {
    const at = text.indexOf("@", i);
    if (at === -1) break;

    let j = at + 1;
    while (j < text.length && /[A-Za-z]/.test(text[j]!)) j++;
    const entryType = text.slice(at + 1, j).toLowerCase();

    let k = j;
    while (k < text.length && /\s/.test(text[k]!)) k++;
    const open = text[k];

    if (!entryType || (open !== "{" && open !== "(")) {
      // Stray "@" in inter-entry comment text — skip it.
      i = at + 1;
      continue;
    }

    const end = findEntryEnd(text, k, open);
    if (end === -1) {
      rowNumber += 1;
      errors.push({
        rowNumber,
        message: `Unterminated BibTeX entry "@${entryType}" (unbalanced braces)`,
        rawChunk: text.slice(at).trimEnd(),
      });
      break; // the rest of the file was consumed by the unbalanced entry
    }

    i = end + 1;
    if (NON_RECORD_TYPES.has(entryType)) continue;

    const rawChunk = text.slice(at, end + 1);
    rowNumber += 1;
    const body = text.slice(k + 1, end);
    const built = buildRecord(entryType, body, rawChunk, rowNumber);
    if ("error" in built) {
      errors.push({ rowNumber, message: built.error, rawChunk });
    } else {
      records.push(built.record);
    }
  }

  if (records.length === 0 && errors.length === 0) {
    errors.push({
      rowNumber: 1,
      message: "No BibTeX entries found",
      rawChunk: text.trim().slice(0, 500),
    });
  }
  return { records, errors };
}

// Index of the character closing the entry opened at `start` (a "{" or "("), or -1.
function findEntryEnd(text: string, start: number, open: string): number {
  if (open === "{") {
    let depth = 0;
    for (let p = start; p < text.length; p++) {
      const ch = text[p];
      if (ch === "{") depth++;
      else if (ch === "}") {
        depth--;
        if (depth === 0) return p;
      }
    }
    return -1;
  }
  // "(" entries: closing ")" at brace depth 0.
  let braces = 0;
  for (let p = start + 1; p < text.length; p++) {
    const ch = text[p];
    if (ch === "{") braces++;
    else if (ch === "}") braces--;
    else if (ch === ")" && braces <= 0) return p;
  }
  return -1;
}

interface ParsedEntryBody {
  citeKey: string;
  fields: Map<string, string>;
}

// body = everything between the entry's opening and closing delimiter.
function parseEntryBody(body: string): ParsedEntryBody {
  const fields = new Map<string, string>();
  let i = 0;

  // Cite key: up to the first top-level comma.
  let depth = 0;
  let keyEnd = body.length;
  for (let p = 0; p < body.length; p++) {
    const ch = body[p];
    if (ch === "{") depth++;
    else if (ch === "}") depth--;
    else if (ch === "," && depth === 0) {
      keyEnd = p;
      break;
    } else if (ch === "=" && depth === 0) {
      // No cite key — the body starts directly with fields.
      keyEnd = -1;
      break;
    }
  }
  let citeKey = "";
  if (keyEnd >= 0) {
    citeKey = body.slice(0, keyEnd).trim();
    i = keyEnd + 1;
  }

  while (i < body.length) {
    // Skip whitespace and commas.
    while (i < body.length && /[\s,]/.test(body[i]!)) i++;
    if (i >= body.length) break;

    // Field name.
    const nameMatch = body.slice(i).match(/^[A-Za-z][A-Za-z0-9_-]*/);
    if (!nameMatch) {
      i++; // tolerate garbage
      continue;
    }
    const name = nameMatch[0].toLowerCase();
    i += nameMatch[0].length;
    while (i < body.length && /\s/.test(body[i]!)) i++;
    if (body[i] !== "=") continue; // malformed field — tolerate and move on
    i++;
    while (i < body.length && /\s/.test(body[i]!)) i++;

    const [value, next] = readValue(body, i);
    i = next;
    if (!fields.has(name)) fields.set(name, cleanValue(value));
  }

  return { citeKey, fields };
}

// Read a field value starting at i: {...} (nested), "..." (may contain braces), or bare token.
function readValue(body: string, i: number): [string, number] {
  const ch = body[i];
  if (ch === "{") {
    let depth = 0;
    for (let p = i; p < body.length; p++) {
      if (body[p] === "{") depth++;
      else if (body[p] === "}") {
        depth--;
        if (depth === 0) return [body.slice(i + 1, p), p + 1];
      }
    }
    return [body.slice(i + 1), body.length];
  }
  if (ch === '"') {
    let braces = 0;
    for (let p = i + 1; p < body.length; p++) {
      if (body[p] === "{") braces++;
      else if (body[p] === "}") braces--;
      else if (body[p] === '"' && braces === 0) return [body.slice(i + 1, p), p + 1];
    }
    return [body.slice(i + 1), body.length];
  }
  // Bare token (number or macro) until a top-level comma or end.
  let p = i;
  while (p < body.length && body[p] !== ",") p++;
  return [body.slice(i, p), p];
}

// Collapse whitespace, drop grouping braces, undo a few common LaTeX escapes.
function cleanValue(value: string): string {
  return value
    .replace(/\s+/g, " ")
    .replace(/[{}]/g, "")
    .replace(/\\([&%$#_])/g, "$1")
    .replace(/~/g, " ")
    .trim();
}

function buildRecord(
  entryType: string,
  body: string,
  rawChunk: string,
  rowNumber: number,
): { record: ParsedRecord } | { error: string } {
  const { fields } = parseEntryBody(body);

  const title = fields.get("title");
  if (!title) return { error: `BibTeX entry "@${entryType}" is missing a title field` };

  const authorField = fields.get("author") ?? "";
  const authors = authorField
    .split(/\s+and\s+/i)
    .map((a) => a.trim())
    .filter((a) => a.length > 0)
    .map(parseAuthorName);

  const record: ParsedRecord = {
    title,
    authors,
    year: extractYear(fields.get("year")),
    journal: fields.get("journal") ?? fields.get("journaltitle") ?? fields.get("booktitle"),
    volume: fields.get("volume"),
    issue: fields.get("number") ?? fields.get("issue"),
    pages: fields.get("pages")?.replace(/--/g, "-"),
    abstract: fields.get("abstract"),
    doi: normalizeDoi(fields.get("doi")) ?? undefined,
    pmid: normalizePmid(fields.get("pmid") ?? fields.get("pubmed") ?? null) ?? undefined,
    url: fields.get("url"),
    language: fields.get("language") ?? fields.get("langid"),
    rawChunk,
    rowNumber,
  };
  return { record };
}
