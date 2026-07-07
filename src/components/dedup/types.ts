// Client-side interfaces for the dedup API payloads (only the fields the UI consumes).

export type DedupMethod = "EXACT_DOI" | "EXACT_PMID" | "NORMALIZED_TITLE" | "FUZZY";
export type DedupCandidateStatus = "SUGGESTED" | "MERGED" | "REJECTED";
export type DedupGroupStatus = "OPEN" | "RESOLVED";

export interface DedupAuthor {
  family: string;
  given?: string;
  raw?: string;
}

// Full citation payload returned by GET /dedup/groups (citationA/citationB includes).
export interface DedupCitation {
  id: string;
  status: "ACTIVE" | "DUPLICATE";
  duplicateOfId: string | null;
  title: string;
  normalizedTitle: string;
  authors: DedupAuthor[] | null; // stored as Json — guard with Array.isArray before use
  year: number | null;
  journal: string | null;
  volume: string | null;
  issue: string | null;
  pages: string | null;
  abstract: string | null;
  doi: string | null;
  pmid: string | null;
  url: string | null;
  identifiers: { id: string; type: string; value: string }[];
}

// Evidence persisted to DeduplicationCandidate.reasons by the detection engine.
export interface PairEvidence {
  titleSimilarity: number;
  authorOverlap: number;
  yearMatch: boolean;
  journalMatch: boolean;
  matchedOn: string[];
}

export interface DedupCandidate {
  id: string;
  citationAId: string;
  citationBId: string;
  method: DedupMethod;
  score: number;
  reasons: PairEvidence | null;
  status: DedupCandidateStatus;
  decidedAt: string | null;
  decidedBy: { id: string; name: string; email: string } | null;
  citationA: DedupCitation;
  citationB: DedupCitation;
}

export interface DedupGroup {
  id: string;
  status: DedupGroupStatus;
  createdAt: string;
  updatedAt: string;
  candidates: DedupCandidate[]; // ordered by score desc
}

export interface RunSummary {
  citationsScanned: number;
  pairsDetected: number;
  candidatesCreated: number;
  candidatesRefreshed: number;
  candidatesSkippedDecided: number;
  groupsOpen: number;
}

export interface MergeWarning {
  code: string;
  message: string;
  canonicalCitationId: string;
  duplicateCitationIdsWithDecisions: string[];
}

export interface MergeResult {
  canonicalCitationId: string;
  mergedCitationIds: string[];
  voidedAssignmentIds: string[];
  voidedConflictIds: string[];
  warning: MergeWarning | null;
}

export interface RejectResult {
  candidate: { id: string; status: DedupCandidateStatus };
  groupResolved: boolean;
}

export interface UndoResult {
  citation: { id: string; title: string };
  groupId: string | null;
  restoredAssignmentIds: string[];
  restoredConflictIds: string[];
}

// GET /citations?status=DUPLICATE — the merges-history data source.
export interface DuplicateCitationRow {
  id: string;
  title: string;
  year: number | null;
  doi: string | null;
  pmid: string | null;
  duplicateOfId: string | null;
  updatedAt: string;
  sources?: { id: string; name: string }[];
}

export interface CitationListResponse {
  items: DuplicateCitationRow[];
  nextCursor: string | null;
}

export const METHOD_LABELS: Record<DedupMethod, string> = {
  EXACT_DOI: "DOI match",
  EXACT_PMID: "PMID match",
  NORMALIZED_TITLE: "Title match",
  FUZZY: "Fuzzy match",
};

export function scorePercent(score: number): string {
  return `${Math.round(score * 100)}%`;
}
