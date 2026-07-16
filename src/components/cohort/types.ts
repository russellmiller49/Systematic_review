// Client-side interfaces for the cohort (companion-report) API payloads — only the
// fields the UI consumes. Mirrors src/server/services/cohort responses.

export type CohortMethod = "REGISTRY_ID" | "COMPOSITE";
export type CohortCandidateStatus = "SUGGESTED" | "LINKED" | "REJECTED";

export interface CohortAuthor {
  family: string;
  given?: string;
  raw?: string;
}

export interface CohortStudyRef {
  id: string;
  label: string;
}

// Citation display payload on GET /cohort/candidates (both sides).
export interface CohortCitation {
  id: string;
  status: "ACTIVE" | "DUPLICATE";
  title: string;
  authors: CohortAuthor[] | null; // stored as Json — guard with Array.isArray before use
  year: number | null;
  journal: string | null;
  doi: string | null;
  pmid: string | null;
  studies: CohortStudyRef[]; // current study links (id + label)
}

// Evidence persisted to CohortCandidate.signals by the detection engine.
export interface CohortSignals {
  registryIds?: string[];
  authorOverlap?: number;
  affiliationSimilarity?: number | null;
  titleSignal?: number;
  acronyms?: string[];
  sharedRareTokens?: string[];
  yearDelta?: number | null;
}

export interface CohortCandidate {
  id: string;
  citationAId: string;
  citationBId: string;
  method: CohortMethod;
  score: number;
  signals: CohortSignals | null;
  status: CohortCandidateStatus;
  decidedAt: string | null;
  decidedBy: { id: string; name: string; email: string } | null;
  citationA: CohortCitation;
  citationB: CohortCitation;
}

// POST /cohort/run response.
export interface CohortRunSummary {
  candidates: number;
  newlySuggested: number;
  refreshed: number;
  removed: number;
  skippedDecided: number;
  populationSize: number;
  backfilled: number;
  populationCapped?: boolean;
}

export type CohortLinkCase =
  | "LINKED_INTO_EXISTING"
  | "CREATED_STUDY"
  | "MERGED_STUDIES"
  | "ALREADY_SAME_STUDY";

// POST /cohort/candidates/:id/link response.
export interface CohortLinkResult {
  candidate: { id: string; status: CohortCandidateStatus };
  case: CohortLinkCase;
  studyId: string;
}

export const COHORT_METHOD_LABELS: Record<CohortMethod, string> = {
  REGISTRY_ID: "Registry ID",
  COMPOSITE: "Composite",
};

export function cohortScorePercent(score: number): string {
  return `${Math.round(score * 100)}%`;
}

// Human-readable evidence chips derived from the persisted signals.
export function evidenceChips(signals: CohortSignals | null): string[] {
  if (!signals) return [];
  const chips: string[] = [];
  for (const id of signals.registryIds ?? []) chips.push(`${id} shared`);
  if (signals.authorOverlap !== undefined && signals.authorOverlap > 0) {
    chips.push(`${Math.round(signals.authorOverlap * 100)}% author overlap`);
  }
  if (
    signals.affiliationSimilarity !== undefined &&
    signals.affiliationSimilarity !== null &&
    signals.affiliationSimilarity > 0
  ) {
    chips.push(
      signals.affiliationSimilarity >= 0.8
        ? "Affiliation match"
        : `${Math.round(signals.affiliationSimilarity * 100)}% affiliation overlap`,
    );
  }
  for (const acronym of signals.acronyms ?? []) chips.push(`Acronym: ${acronym}`);
  if (signals.yearDelta !== undefined && signals.yearDelta !== null) {
    chips.push(signals.yearDelta === 0 ? "Same year" : `Δ${signals.yearDelta} year${signals.yearDelta === 1 ? "" : "s"}`);
  }
  return chips;
}

// What pressing "Link" will do for this candidate, recomputed from current study links.
export function linkActionPreview(candidate: CohortCandidate): string {
  const aStudies = candidate.citationA.studies;
  const bStudies = candidate.citationB.studies;
  const sharedStudy = aStudies.find((s) => bStudies.some((t) => t.id === s.id));
  if (sharedStudy) {
    return `Both reports already belong to study ${sharedStudy.label} — linking records the decision.`;
  }
  if (aStudies.length > 0 && bStudies.length === 0) {
    return `Will add report to study ${aStudies[0]!.label}`;
  }
  if (bStudies.length > 0 && aStudies.length === 0) {
    return `Will add report to study ${bStudies[0]!.label}`;
  }
  if (aStudies.length === 0 && bStudies.length === 0) {
    return "Will create a new study with both reports";
  }
  return `Will merge study ${bStudies[0]!.label} into ${aStudies[0]!.label} (blocked if it already has extraction or risk-of-bias work)`;
}
