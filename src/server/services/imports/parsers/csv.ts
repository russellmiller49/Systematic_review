// CSV parser (papaparse, header-based with flexible header aliases).
// Pure, never throws — rows without a title become error rows.
import Papa from "papaparse";
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

type CanonicalField =
  | "title"
  | "abstract"
  | "authors"
  | "year"
  | "journal"
  | "doi"
  | "pmid"
  | "url"
  | "volume"
  | "issue"
  | "pages"
  | "language";

// Alias → canonical field. Headers are matched after lowercasing and stripping non-alphanumerics.
const HEADER_ALIASES: Record<string, CanonicalField> = {
  title: "title",
  ti: "title",
  articletitle: "title",
  primarytitle: "title",
  abstract: "abstract",
  ab: "abstract",
  authors: "authors",
  author: "authors",
  au: "authors",
  year: "year",
  py: "year",
  publicationyear: "year",
  pubyear: "year",
  journal: "journal",
  source: "journal",
  sourcetitle: "journal",
  journalname: "journal",
  publication: "journal",
  jo: "journal",
  doi: "doi",
  do: "doi",
  pmid: "pmid",
  pubmedid: "pmid",
  url: "url",
  link: "url",
  ur: "url",
  volume: "volume",
  vl: "volume",
  issue: "issue",
  number: "issue",
  is: "issue",
  pages: "pages",
  pg: "pages",
  language: "language",
  lang: "language",
  la: "language",
};

function canonicalize(header: string): CanonicalField | null {
  const key = header.toLowerCase().replace(/[^a-z0-9]/g, "");
  return HEADER_ALIASES[key] ?? null;
}

export function parseCsv(content: string): ParseResult {
  const text = preprocess(content);
  if (text.trim().length === 0) return emptyFileResult();

  const result = Papa.parse<Record<string, string>>(text, {
    header: true,
    skipEmptyLines: "greedy",
  });

  const headers = result.meta.fields ?? [];
  // header name → canonical field (first matching header wins per canonical field)
  const mapping = new Map<CanonicalField, string>();
  for (const header of headers) {
    const canonical = canonicalize(header);
    if (canonical && !mapping.has(canonical)) mapping.set(canonical, header);
  }

  const records: ParsedRecord[] = [];
  const errors: ParseRowError[] = [];

  // Per-row papaparse issues (extra/missing fields, quote errors) — appended to any
  // error message for that row; rows that still yield a title are kept.
  const rowIssues = new Map<number, string[]>();
  for (const err of result.errors) {
    if (typeof err.row === "number") {
      const list = rowIssues.get(err.row) ?? [];
      list.push(err.message);
      rowIssues.set(err.row, list);
    }
  }

  if (result.data.length === 0) {
    return {
      records: [],
      errors: [
        {
          rowNumber: 1,
          message: "No data rows found in CSV",
          rawChunk: text.split("\n", 1)[0] ?? "",
        },
      ],
    };
  }

  result.data.forEach((row, idx) => {
    const rowNumber = idx + 1; // 1-based data row number (header excluded)
    const rawChunk = Papa.unparse([headers.map((h) => row[h] ?? "")], { newline: "\n" });
    const get = (field: CanonicalField): string | undefined => {
      const header = mapping.get(field);
      if (!header) return undefined;
      const value = row[header]?.trim();
      return value ? value : undefined;
    };

    const title = get("title");
    if (!title) {
      const issues = rowIssues.get(idx);
      errors.push({
        rowNumber,
        message: `CSV row is missing a title${issues ? ` (${issues.join("; ")})` : ""}`,
        rawChunk,
      });
      return;
    }

    const authors = (get("authors") ?? "")
      .split(";")
      .map((a) => a.trim())
      .filter((a) => a.length > 0)
      .map(parseAuthorName);

    records.push({
      title,
      authors,
      year: extractYear(get("year")),
      journal: get("journal"),
      volume: get("volume"),
      issue: get("issue"),
      pages: get("pages"),
      abstract: get("abstract"),
      doi: normalizeDoi(get("doi")) ?? undefined,
      pmid: normalizePmid(get("pmid") ?? null) ?? undefined,
      url: get("url"),
      language: get("language"),
      rawChunk,
      rowNumber,
    });
  });

  return { records, errors };
}
