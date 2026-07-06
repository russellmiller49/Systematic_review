// RIS parser (TY..ER blocks). Pure, never throws — malformed blocks become error rows.
import { normalizeDoi, parseAuthorName } from "@/server/services/citations/normalize";
import {
  emptyFileResult,
  extractYear,
  preprocess,
  type ParsedRecord,
  type ParseResult,
  type ParseRowError,
} from "./types";

// "TY  - JOUR" — two-char tag, two spaces, dash, optional space, value.
const TAG_RE = /^([A-Z][A-Z0-9])  -\s?(.*)$/;

interface OpenRecord {
  tags: Map<string, string[]>;
  lines: string[];
  lastTag: string | null;
}

export function parseRis(content: string): ParseResult {
  const text = preprocess(content);
  if (text.trim().length === 0) return emptyFileResult();

  const records: ParsedRecord[] = [];
  const errors: ParseRowError[] = [];
  let rowNumber = 0;
  let current: OpenRecord | null = null;
  let stray: string[] = [];

  const flushStray = () => {
    const chunk = stray.join("\n").trim();
    stray = [];
    if (chunk) {
      rowNumber += 1;
      errors.push({
        rowNumber,
        message: "Content outside of a RIS record (expected a TY..ER block)",
        rawChunk: chunk,
      });
    }
  };

  const finishRecord = (terminated: boolean) => {
    if (!current) return;
    const rawChunk = current.lines.join("\n").trimEnd();
    rowNumber += 1;
    if (!terminated) {
      errors.push({
        rowNumber,
        message: "Unterminated RIS record (missing ER tag)",
        rawChunk,
      });
    } else {
      const built = buildRecord(current.tags, rawChunk, rowNumber);
      if ("error" in built) {
        errors.push({ rowNumber, message: built.error, rawChunk });
      } else {
        records.push(built.record);
      }
    }
    current = null;
  };

  for (const line of text.split("\n")) {
    const m = line.match(TAG_RE);
    if (current) {
      if (m && m[1] === "TY") {
        // A new record started before the previous one was terminated.
        finishRecord(false);
        current = { tags: new Map([["TY", [m[2] ?? ""]]]), lines: [line], lastTag: "TY" };
        continue;
      }
      current.lines.push(line);
      if (m) {
        const tag = m[1]!;
        const value = m[2] ?? "";
        if (tag === "ER") {
          finishRecord(true);
          continue;
        }
        const values = current.tags.get(tag) ?? [];
        values.push(value);
        current.tags.set(tag, values);
        current.lastTag = tag;
      } else if (line.trim() !== "" && current.lastTag) {
        // Continuation line: append to the last tag's most recent value.
        const values = current.tags.get(current.lastTag)!;
        const idx = values.length - 1;
        values[idx] = `${values[idx] ?? ""} ${line.trim()}`.trim();
      }
    } else if (m && m[1] === "TY") {
      flushStray();
      current = { tags: new Map([["TY", [m[2] ?? ""]]]), lines: [line], lastTag: "TY" };
    } else if (line.trim() === "") {
      flushStray();
    } else {
      stray.push(line);
    }
  }
  if (current) finishRecord(false);
  flushStray();

  return { records, errors };
}

function firstValue(tags: Map<string, string[]>, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const values = tags.get(key);
    const found = values?.find((v) => v.trim().length > 0);
    if (found) return found.trim();
  }
  return undefined;
}

function buildRecord(
  tags: Map<string, string[]>,
  rawChunk: string,
  rowNumber: number,
): { record: ParsedRecord } | { error: string } {
  const title = firstValue(tags, "TI", "T1");
  if (!title) return { error: "RIS record is missing a title (TI/T1)" };

  const authorValues = [...(tags.get("AU") ?? []), ...(tags.get("A1") ?? [])]
    .map((a) => a.trim())
    .filter((a) => a.length > 0);
  const authors = authorValues.map(parseAuthorName);

  const sp = firstValue(tags, "SP");
  const ep = firstValue(tags, "EP");
  const pages = sp && ep ? (sp.includes("-") ? sp : `${sp}-${ep}`) : (sp ?? ep);

  const record: ParsedRecord = {
    title,
    authors,
    year: extractYear(firstValue(tags, "PY", "Y1")),
    journal: firstValue(tags, "JO", "JF", "T2"),
    volume: firstValue(tags, "VL"),
    issue: firstValue(tags, "IS"),
    pages,
    abstract: firstValue(tags, "AB", "N2"),
    doi: normalizeDoi(firstValue(tags, "DO")) ?? undefined,
    url: firstValue(tags, "UR"),
    language: firstValue(tags, "LA"),
    rawChunk,
    rowNumber,
  };
  return { record };
}
