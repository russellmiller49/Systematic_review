// Normalization shared by import (Citation.normalizedTitle/doi) and dedup matching.
// Pure functions — unit-tested, no I/O.

// Lowercase, strip diacritics, collapse punctuation/whitespace to single spaces.
export function normalizeTitle(title: string): string {
  return title
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "") // combining diacritics
    .toLowerCase()
    .replace(/&[a-z]+;/g, " ") // stray HTML entities
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

// Canonical DOI: lowercase, no resolver prefix, no trailing punctuation.
export function normalizeDoi(doi: string | null | undefined): string | null {
  if (!doi) return null;
  const cleaned = doi
    .trim()
    .replace(/^(https?:\/\/)?(dx\.)?doi\.org\//i, "")
    .replace(/^doi:\s*/i, "")
    .trim()
    .replace(/[.,;]$/, "")
    .toLowerCase();
  return /^10\.\d{4,9}\/\S+$/.test(cleaned) ? cleaned : cleaned.length > 0 ? cleaned : null;
}

// PMIDs are numeric strings; strip a "PMID:" prefix and validate.
export function normalizePmid(pmid: string | number | null | undefined): string | null {
  if (pmid === null || pmid === undefined) return null;
  const cleaned = String(pmid).replace(/^pmid:?\s*/i, "").trim();
  return /^\d{1,9}$/.test(cleaned) ? cleaned : null;
}

export interface AuthorName {
  family: string;
  given?: string;
  raw?: string;
}

// "Smith, John A." | "John A. Smith" | "Smith JA" → {family, given}. Best-effort.
export function parseAuthorName(raw: string): AuthorName {
  const trimmed = raw.trim();
  if (!trimmed) return { family: "", raw };
  const comma = trimmed.indexOf(",");
  if (comma !== -1) {
    return {
      family: trimmed.slice(0, comma).trim(),
      given: trimmed.slice(comma + 1).trim() || undefined,
      raw: trimmed,
    };
  }
  const parts = trimmed.split(/\s+/);
  if (parts.length === 1) return { family: parts[0]!, raw: trimmed };
  return {
    family: parts[parts.length - 1]!,
    given: parts.slice(0, -1).join(" "),
    raw: trimmed,
  };
}

// Author-overlap score for fuzzy dedup: Jaccard on normalized family names.
export function authorOverlap(a: AuthorName[], b: AuthorName[]): number {
  const fams = (list: AuthorName[]) =>
    new Set(list.map((x) => normalizeTitle(x.family)).filter((s) => s.length > 0));
  const fa = fams(a);
  const fb = fams(b);
  if (fa.size === 0 || fb.size === 0) return 0;
  let inter = 0;
  for (const f of fa) if (fb.has(f)) inter++;
  return inter / (fa.size + fb.size - inter);
}
