import {
  authorOverlap,
  normalizeDoi,
  normalizePmid,
  normalizeTitle,
  type AuthorName,
} from "@/server/services/citations/normalize";
import { jaroWinkler } from "./similarity";

export type ConflictCitation = {
  normalizedTitle: string;
  doi: string | null;
  pmid: string | null;
  year: number | null;
  authors: unknown;
};

function authors(value: unknown): AuthorName[] {
  return Array.isArray(value)
    ? value.filter(
        (item): item is AuthorName =>
          item !== null &&
          typeof item === "object" &&
          typeof item.family === "string" &&
          normalizeTitle(item.family).length > 0,
      )
    : [];
}

// Derived from imported records only; exact identifier evidence is never bibliographic truth.
export function metadataConflicts(a: ConflictCitation, b: ConflictCitation): string[] {
  const aDoi = normalizeDoi(a.doi),
    bDoi = normalizeDoi(b.doi);
  const aPmid = normalizePmid(a.pmid),
    bPmid = normalizePmid(b.pmid);
  const sameDoi = aDoi !== null && aDoi === bDoi;
  const samePmid = aPmid !== null && aPmid === bPmid;
  const conflicts: string[] = [];
  if (sameDoi && aPmid && bPmid && aPmid !== bPmid) {
    conflicts.push("Same DOI but different PMIDs");
  }
  if (samePmid && aDoi && bDoi && aDoi !== bDoi) {
    conflicts.push("Same PMID but different DOIs");
  }
  const aAuthors = authors(a.authors),
    bAuthors = authors(b.authors);
  if (
    (sameDoi || samePmid) &&
    a.normalizedTitle.length >= 20 &&
    b.normalizedTitle.length >= 20 &&
    jaroWinkler(a.normalizedTitle, b.normalizedTitle) < 0.7 &&
    aAuthors.length > 0 &&
    bAuthors.length > 0 &&
    authorOverlap(aAuthors, bAuthors) === 0 &&
    a.year !== null &&
    b.year !== null &&
    Math.abs(a.year - b.year) > 1
  ) {
    conflicts.push("Matching identifier but strong title, author, and year disagreement");
  }
  return conflicts;
}

// Also inspect nonadjacent members: missing metadata on an intermediate citation must
// not hide contradictory PMIDs (or bibliographic disagreement) in a bulk DOI cluster.
export function clusterMetadataConflicts(citations: ConflictCitation[]): string[] {
  const conflicts = new Set<string>();
  for (let i = 0; i < citations.length; i++) {
    for (let j = i + 1; j < citations.length; j++) {
      for (const reason of metadataConflicts(citations[i]!, citations[j]!)) conflicts.add(reason);
    }
  }
  return [...conflicts];
}
