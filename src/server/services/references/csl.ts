// CSL-JSON mappings for the reference library — pure functions, unit-tested.
// The `csl` Json column is the source of truth; these mappers convert every ingest path
// (Crossref, PubMed esummary, RIS/BibTeX parser output, screening Citations, manual
// forms) into one CSL item shape, and denormalizeCsl() derives the searchable columns.
//
// Convention: PMID is carried as a top-level custom `PMID` key (citeproc ignores unknown
// keys; our writers and denormalizer read it). DOI uses the standard CSL `DOI` key.

import { z } from "zod";
import type { Citation } from "@prisma/client";
import {
  normalizeDoi,
  normalizePmid,
  parseAuthorName,
} from "@/server/services/citations/normalize";
import { extractYear } from "@/server/services/imports/parsers/types";
import type { ParsedRecord } from "@/server/services/imports/parsers/types";

// Minimal validity: a type and a non-empty title. Everything else passes through so
// callers can store any legitimate CSL field.
export const cslItemSchema = z
  .object({
    type: z.string().trim().min(1).max(50),
    title: z.string().trim().min(1).max(1000),
  })
  .passthrough();

export type CslItemInput = z.infer<typeof cslItemSchema> & Record<string, unknown>;

export interface CslAuthor {
  family?: string;
  given?: string;
  literal?: string;
}

function issuedFromYear(year: number | null | undefined): { "date-parts": number[][] } | undefined {
  return typeof year === "number" && Number.isFinite(year)
    ? { "date-parts": [[year]] }
    : undefined;
}

function compact<T extends object>(obj: T): T {
  const record = obj as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (record[key] === undefined || record[key] === null || record[key] === "") {
      delete record[key];
    }
  }
  return obj;
}

// --- Crossref (api.crossref.org/works/{doi} → message) -------------------------------

const CROSSREF_TYPE_MAP: Record<string, string> = {
  "journal-article": "article-journal",
  "proceedings-article": "paper-conference",
  "book-chapter": "chapter",
  "book-section": "chapter",
  monograph: "book",
  book: "book",
  report: "report",
  dataset: "dataset",
  "posted-content": "article",
};

export function crossrefToCsl(message: unknown): CslItemInput {
  const m = (message ?? {}) as Record<string, unknown>;
  const title = Array.isArray(m.title) ? String(m.title[0] ?? "") : String(m.title ?? "");
  const container = Array.isArray(m["container-title"])
    ? String(m["container-title"][0] ?? "")
    : undefined;
  const authors = Array.isArray(m.author)
    ? (m.author as Record<string, unknown>[]).map((a) =>
        compact<CslAuthor>({
          family: typeof a.family === "string" ? a.family : undefined,
          given: typeof a.given === "string" ? a.given : undefined,
          literal:
            typeof a.name === "string" && typeof a.family !== "string" ? a.name : undefined,
        }),
      )
    : undefined;
  const issued =
    m.issued && typeof m.issued === "object" ? (m.issued as Record<string, unknown>) : undefined;
  const type = CROSSREF_TYPE_MAP[String(m.type ?? "")] ?? "article-journal";
  const abstract =
    typeof m.abstract === "string" ? m.abstract.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim() : undefined;

  return cslItemSchema.parse(
    compact({
      type,
      title: title.replace(/\s+/g, " ").trim(),
      author: authors && authors.length > 0 ? authors : undefined,
      "container-title": container,
      issued,
      volume: typeof m.volume === "string" ? m.volume : undefined,
      issue: typeof m.issue === "string" ? m.issue : undefined,
      page: typeof m.page === "string" ? m.page : undefined,
      DOI: normalizeDoi(typeof m.DOI === "string" ? m.DOI : undefined) ?? undefined,
      URL: typeof m.URL === "string" ? m.URL : undefined,
      abstract,
    }),
  ) as CslItemInput;
}

// --- PubMed esummary (eutils esummary.fcgi?db=pubmed&retmode=json → result[pmid]) -----

// esummary author names are "Family FM" (family then initials).
function pubmedAuthorToCsl(name: string): CslAuthor {
  const trimmed = name.trim();
  const parts = trimmed.split(/\s+/);
  const last = parts[parts.length - 1] ?? "";
  if (parts.length > 1 && /^[A-Za-z]{1,3}$/.test(last) && last === last.toUpperCase()) {
    return { family: parts.slice(0, -1).join(" "), given: last };
  }
  const parsed = parseAuthorName(trimmed);
  return compact<CslAuthor>({ family: parsed.family || undefined, given: parsed.given });
}

export function pubmedSummaryToCsl(docsum: unknown): CslItemInput {
  const d = (docsum ?? {}) as Record<string, unknown>;
  const title = String(d.title ?? "")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\.$/, "");
  const authors = Array.isArray(d.authors)
    ? (d.authors as Record<string, unknown>[])
        .map((a) => (typeof a.name === "string" ? pubmedAuthorToCsl(a.name) : null))
        .filter((a): a is CslAuthor => a !== null && (!!a.family || !!a.literal))
    : [];
  const year = extractYear(typeof d.pubdate === "string" ? d.pubdate : undefined);
  const ids = Array.isArray(d.articleids) ? (d.articleids as Record<string, unknown>[]) : [];
  const doiRaw = ids.find((i) => i.idtype === "doi")?.value;
  const pmidRaw = ids.find((i) => i.idtype === "pubmed")?.value ?? d.uid;

  return cslItemSchema.parse(
    compact({
      type: "article-journal",
      title,
      author: authors.length > 0 ? authors : undefined,
      "container-title":
        typeof d.fulljournalname === "string" && d.fulljournalname
          ? d.fulljournalname
          : typeof d.source === "string"
            ? d.source
            : undefined,
      issued: issuedFromYear(year ?? null),
      volume: typeof d.volume === "string" && d.volume ? d.volume : undefined,
      issue: typeof d.issue === "string" && d.issue ? d.issue : undefined,
      page: typeof d.pages === "string" && d.pages ? d.pages : undefined,
      DOI: normalizeDoi(typeof doiRaw === "string" ? doiRaw : undefined) ?? undefined,
      PMID: normalizePmid(typeof pmidRaw === "string" || typeof pmidRaw === "number" ? pmidRaw : undefined) ?? undefined,
    }),
  ) as CslItemInput;
}

// --- Import parser output (RIS/BibTeX) ------------------------------------------------

function parsedAuthorsToCsl(authors: ParsedRecord["authors"]): CslAuthor[] {
  return authors
    .map((a) => {
      if (a.family) return compact<CslAuthor>({ family: a.family, given: a.given });
      if (a.raw) return { literal: a.raw };
      return null;
    })
    .filter((a): a is CslAuthor => a !== null);
}

export function parsedRecordToCsl(record: ParsedRecord): CslItemInput {
  return cslItemSchema.parse(
    compact({
      type: "article-journal",
      title: record.title,
      author: record.authors.length > 0 ? parsedAuthorsToCsl(record.authors) : undefined,
      "container-title": record.journal,
      issued: issuedFromYear(record.year),
      volume: record.volume,
      issue: record.issue,
      page: record.pages,
      DOI: normalizeDoi(record.doi) ?? undefined,
      PMID: normalizePmid(record.pmid) ?? undefined,
      URL: record.url,
      abstract: record.abstract,
    }),
  ) as CslItemInput;
}

// --- Screening Citation rows ----------------------------------------------------------

export function citationToCsl(
  citation: Pick<
    Citation,
    | "title"
    | "authors"
    | "year"
    | "journal"
    | "volume"
    | "issue"
    | "pages"
    | "abstract"
    | "doi"
    | "pmid"
    | "url"
  >,
): CslItemInput {
  const authors = Array.isArray(citation.authors)
    ? (citation.authors as Record<string, unknown>[])
        .map((a) => {
          const family = typeof a.family === "string" ? a.family : undefined;
          const given = typeof a.given === "string" ? a.given : undefined;
          const raw = typeof a.raw === "string" ? a.raw : undefined;
          if (family) return compact<CslAuthor>({ family, given });
          if (raw) return { literal: raw };
          return null;
        })
        .filter((a): a is CslAuthor => a !== null)
    : [];

  return cslItemSchema.parse(
    compact({
      type: "article-journal",
      title: citation.title,
      author: authors.length > 0 ? authors : undefined,
      "container-title": citation.journal ?? undefined,
      issued: issuedFromYear(citation.year),
      volume: citation.volume ?? undefined,
      issue: citation.issue ?? undefined,
      page: citation.pages ?? undefined,
      DOI: normalizeDoi(citation.doi) ?? undefined,
      PMID: normalizePmid(citation.pmid) ?? undefined,
      URL: citation.url ?? undefined,
      abstract: citation.abstract ?? undefined,
    }),
  ) as CslItemInput;
}

// --- Denormalized searchable columns --------------------------------------------------

export function denormalizeCsl(csl: CslItemInput): {
  title: string;
  firstAuthor: string | null;
  year: number | null;
  doi: string | null;
  pmid: string | null;
} {
  const authors = Array.isArray(csl.author) ? (csl.author as CslAuthor[]) : [];
  const first = authors[0];
  const issued = csl.issued as { "date-parts"?: unknown } | undefined;
  const parts = issued?.["date-parts"];
  const rawYear = Array.isArray(parts) && Array.isArray(parts[0]) ? parts[0][0] : null;
  return {
    title: csl.title,
    firstAuthor: first?.family ?? first?.literal ?? null,
    year: typeof rawYear === "number" ? rawYear : null,
    doi: normalizeDoi(typeof csl.DOI === "string" ? csl.DOI : undefined),
    pmid: normalizePmid(
      typeof csl.PMID === "string" || typeof csl.PMID === "number" ? csl.PMID : undefined,
    ),
  };
}
