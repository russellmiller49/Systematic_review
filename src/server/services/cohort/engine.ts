// PURE cohort-overlap engine — no I/O, no Prisma. Detects companion reports of the same
// underlying study cohort among the project's analysis-relevant citations. The service
// (index.ts) selects the population and persists the pairs. Unit-tested in engine.test.ts.
//
// Two tiers:
//  1. REGISTRY_ID — any shared trial-registry identifier → score 0.98.
//  2. COMPOSITE — weighted author / affiliation / title / year composite. Components
//     that are unknowable for a pair (no affiliations on either side, missing year) are
//     DROPPED and the remaining weights are renormalized to sum 1 — a missing signal is
//     not evidence against a match.
//
// Composite pairs are gated on authorOverlap >= 0.2 (companion reports share authors;
// this also lets us block candidate pairs on shared author keys instead of O(n²) scans)
// and emitted at score >= 0.55.
//
// Skips (both tiers): pairs already linked to the SAME study (nothing to detect) and
// pairs with an identical non-null DOI (that's the dedup domain's territory).

import type { AuthorName } from "@/server/services/citations/normalize";
import { normalizeTitle } from "@/server/services/citations/normalize";

export type CohortEngineMethod = "REGISTRY_ID" | "COMPOSITE";

export type CohortCitationLite = {
  id: string;
  title: string;
  authors: AuthorName[]; // the Citation.authors Json shape
  year: number | null;
  affiliations: string[] | null; // null = never captured (no source data)
  registryIds: string[]; // canonical uppercase forms (REGISTRY_ID identifiers)
  doi: string | null; // normalized
  studyIds: string[]; // current StudyReportLink memberships
};

// Evidence persisted to CohortCandidate.signals — the UI derives its chips from this.
export type CohortSignals = {
  registryIds?: string[]; // tier 1 only: the shared registry ids
  authorOverlap: number;
  affiliationSimilarity: number | null; // null = dropped (no affiliations on a side)
  titleSignal: number;
  acronyms: string[]; // shared trial-acronym tokens (e.g. "LIBERATE")
  sharedRareTokens: string[]; // shared rare title tokens backing the title signal
  yearDelta: number | null; // null = dropped (missing year on a side)
};

export type CohortPair = {
  aId: string; // invariant: aId < bId
  bId: string;
  method: CohortEngineMethod;
  score: number; // 0.98 for REGISTRY_ID, weighted composite otherwise
  signals: CohortSignals;
};

export const REGISTRY_SCORE = 0.98;
export const COMPOSITE_THRESHOLD = 0.55;
export const AUTHOR_OVERLAP_GATE = 0.2;

// Weights sum to 1. When affiliation and/or year are dropped for a pair the remaining
// weights are divided by their sum (e.g. no affiliations AND no year → author 0.40/0.65,
// title 0.25/0.65).
export const COMPOSITE_WEIGHTS = {
  author: 0.4,
  affiliation: 0.2,
  title: 0.25,
  year: 0.15,
} as const;

const round4 = (x: number) => Math.round(x * 10000) / 10000;
const orderPair = (x: string, y: string): [string, string] => (x < y ? [x, y] : [y, x]);
const pairKey = (aId: string, bId: string) => `${aId}|${bId}`;

// ---------------------------------------------------------------------------
// Component signals
// ---------------------------------------------------------------------------

// Author key: normalized family name + first initial of the given name ("criner|g").
// Jaccard over these keys is stricter than family-only overlap (dedup's measure) —
// companion reports repeat the same people, not just the same surnames.
function authorKeys(authors: AuthorName[]): Set<string> {
  const keys = new Set<string>();
  for (const a of authors) {
    const family = normalizeTitle(a.family ?? "");
    if (!family) continue;
    const initial = (a.given ?? "").trim().charAt(0).toLowerCase();
    keys.add(`${family}|${initial}`);
  }
  return keys;
}

function jaccard(a: ReadonlySet<string>, b: ReadonlySet<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  return inter / (a.size + b.size - inter);
}

// Affiliation string → token set: lowercase, strip emails / numbers / punctuation.
function affiliationTokens(affiliation: string): Set<string> {
  const cleaned = affiliation
    .toLowerCase()
    .replace(/\S+@\S+/g, " ") // emails
    .replace(/\d+/g, " ") // numbers (zip codes, street numbers)
    .replace(/[^a-z]+/g, " ");
  return new Set(cleaned.split(" ").filter((t) => t.length >= 2));
}

// Best pairwise token-set Jaccard across the two affiliation bags.
function affiliationSimilarity(a: string[], b: string[]): number {
  const aSets = a.map(affiliationTokens);
  const bSets = b.map(affiliationTokens);
  let best = 0;
  for (const sa of aSets) {
    for (const sb of bSets) {
      const sim = jaccard(sa, sb);
      if (sim > best) best = sim;
    }
  }
  return best;
}

// Trial acronyms: ALL-CAPS tokens of length 3–10 in the raw (un-normalized) title.
function titleAcronyms(title: string): Set<string> {
  const tokens = title.split(/[^A-Za-z0-9]+/);
  return new Set(tokens.filter((t) => /^[A-Z]{3,10}$/.test(t)));
}

// Generic tokens that stay frequent even in small populations — excluded from the
// rare-token pool regardless of document frequency.
const TITLE_STOPWORDS = new Set([
  "with",
  "from",
  "this",
  "that",
  "study",
  "trial",
  "randomized",
  "randomised",
  "controlled",
  "versus",
  "among",
  "between",
  "after",
  "results",
  "effect",
  "effects",
  "outcomes",
  "outcome",
  "patients",
  "severe",
  "clinical",
  "term",
  "long",
  "follow",
  "month",
  "months",
  "year",
  "years",
]);

function titleTokens(title: string): Set<string> {
  return new Set(
    normalizeTitle(title)
      .split(" ")
      .filter((t) => t.length >= 4 && !TITLE_STOPWORDS.has(t)),
  );
}

// |Δyear| 0,1,2,3,>=4 → 1, 0.75, 0.5, 0.25, 0
function yearProximity(delta: number): number {
  return delta <= 3 ? 1 - delta * 0.25 : 0;
}

// ---------------------------------------------------------------------------
// Detection
// ---------------------------------------------------------------------------

export function detectCohortOverlap(citations: CohortCitationLite[]): CohortPair[] {
  const byId = new Map(citations.map((c) => [c.id, c]));

  // Precompute per-citation derived sets.
  const authorsOf = new Map(citations.map((c) => [c.id, authorKeys(c.authors)]));
  const rawAcronymsOf = new Map(citations.map((c) => [c.id, titleAcronyms(c.title)]));
  const registryOf = new Map(citations.map((c) => [c.id, new Set(c.registryIds)]));

  // Rare title tokens: document frequency over the population; a token is "rare" when it
  // appears in at most max(2, 10% of titles) — shared rare tokens are real evidence,
  // shared boilerplate ("emphysema" in an emphysema review) is not.
  const tokensOf = new Map(citations.map((c) => [c.id, titleTokens(c.title)]));
  const df = new Map<string, number>();
  for (const tokens of tokensOf.values()) {
    for (const t of tokens) df.set(t, (df.get(t) ?? 0) + 1);
  }
  const rareDfMax = Math.max(2, Math.ceil(citations.length * 0.1));
  const rareTokensOf = new Map<string, Set<string>>();
  for (const [id, tokens] of tokensOf) {
    rareTokensOf.set(id, new Set([...tokens].filter((t) => (df.get(t) ?? 0) <= rareDfMax)));
  }

  // Acronyms carry a forced titleSignal of 1, so they get the same rarity treatment:
  // "COPD" in a COPD review or "III" (phase III) is boilerplate, not a trial name.
  const ROMAN_NUMERAL = /^[IVXLCDM]+$/;
  const GENERIC_ACRONYMS = new Set(["RCT"]);
  const acronymDf = new Map<string, number>();
  for (const acronyms of rawAcronymsOf.values()) {
    for (const t of acronyms) acronymDf.set(t, (acronymDf.get(t) ?? 0) + 1);
  }
  const acronymsOf = new Map<string, Set<string>>();
  for (const [id, acronyms] of rawAcronymsOf) {
    acronymsOf.set(
      id,
      new Set(
        [...acronyms].filter(
          (t) =>
            (acronymDf.get(t) ?? 0) <= rareDfMax &&
            !ROMAN_NUMERAL.test(t) &&
            !GENERIC_ACRONYMS.has(t),
        ),
      ),
    );
  }

  // Candidate pairs: shared registry id (tier 1) OR shared author key (a necessary
  // condition for passing the composite author gate).
  const candidateKeys = new Set<string>();
  const addBucketPairs = (bucket: Map<string, string[]>) => {
    for (const ids of bucket.values()) {
      if (ids.length < 2) continue;
      for (let i = 0; i < ids.length; i++) {
        for (let j = i + 1; j < ids.length; j++) {
          const [aId, bId] = orderPair(ids[i]!, ids[j]!);
          candidateKeys.add(pairKey(aId, bId));
        }
      }
    }
  };
  const registryBuckets = new Map<string, string[]>();
  const authorBuckets = new Map<string, string[]>();
  for (const c of citations) {
    for (const rid of c.registryIds) {
      (registryBuckets.get(rid) ?? registryBuckets.set(rid, []).get(rid)!).push(c.id);
    }
    for (const key of authorsOf.get(c.id)!) {
      (authorBuckets.get(key) ?? authorBuckets.set(key, []).get(key)!).push(c.id);
    }
  }
  addBucketPairs(registryBuckets);
  addBucketPairs(authorBuckets);

  const pairs: CohortPair[] = [];
  for (const key of [...candidateKeys].sort()) {
    const [aId, bId] = key.split("|", 2) as [string, string];
    const a = byId.get(aId)!;
    const b = byId.get(bId)!;

    // Skip: already linked to the same study — the relationship is already recorded.
    if (a.studyIds.some((id) => b.studyIds.includes(id))) continue;
    // Skip: identical non-null DOI — the same report, i.e. dedup's territory.
    if (a.doi !== null && a.doi === b.doi) continue;

    const sharedRegistryIds = [...registryOf.get(aId)!]
      .filter((rid) => registryOf.get(bId)!.has(rid))
      .sort();

    const authorOverlap = round4(jaccard(authorsOf.get(aId)!, authorsOf.get(bId)!));

    const aHasAffiliations = a.affiliations !== null && a.affiliations.length > 0;
    const bHasAffiliations = b.affiliations !== null && b.affiliations.length > 0;
    const affiliationScore =
      aHasAffiliations && bHasAffiliations
        ? round4(affiliationSimilarity(a.affiliations!, b.affiliations!))
        : null;

    const sharedAcronyms = [...acronymsOf.get(aId)!]
      .filter((t) => acronymsOf.get(bId)!.has(t))
      .sort();
    const sharedRareTokens = [...rareTokensOf.get(aId)!]
      .filter((t) => rareTokensOf.get(bId)!.has(t))
      .sort();
    const titleSignal =
      sharedAcronyms.length > 0
        ? 1
        : round4(Math.min(1, jaccard(rareTokensOf.get(aId)!, rareTokensOf.get(bId)!)));

    const yearDelta = a.year !== null && b.year !== null ? Math.abs(a.year - b.year) : null;

    const signals: CohortSignals = {
      authorOverlap,
      affiliationSimilarity: affiliationScore,
      titleSignal,
      acronyms: sharedAcronyms,
      sharedRareTokens,
      yearDelta,
    };

    // ------------------------------------------------------------- tier 1
    if (sharedRegistryIds.length > 0) {
      pairs.push({
        aId,
        bId,
        method: "REGISTRY_ID",
        score: REGISTRY_SCORE,
        signals: { registryIds: sharedRegistryIds, ...signals },
      });
      continue;
    }

    // ------------------------------------------------------------- tier 2
    if (authorOverlap < AUTHOR_OVERLAP_GATE) continue;

    const components: { weight: number; value: number }[] = [
      { weight: COMPOSITE_WEIGHTS.author, value: authorOverlap },
      { weight: COMPOSITE_WEIGHTS.title, value: titleSignal },
    ];
    if (affiliationScore !== null) {
      components.push({ weight: COMPOSITE_WEIGHTS.affiliation, value: affiliationScore });
    }
    if (yearDelta !== null) {
      components.push({ weight: COMPOSITE_WEIGHTS.year, value: yearProximity(yearDelta) });
    }
    const totalWeight = components.reduce((sum, c) => sum + c.weight, 0);
    const score = round4(
      components.reduce((sum, c) => sum + c.weight * c.value, 0) / totalWeight,
    );
    if (score < COMPOSITE_THRESHOLD) continue;

    pairs.push({ aId, bId, method: "COMPOSITE", score, signals });
  }

  // candidateKeys iteration is already sorted; keep the invariant explicit anyway.
  return pairs.sort((p, q) =>
    p.aId === q.aId ? (p.bId < q.bId ? -1 : 1) : p.aId < q.aId ? -1 : 1,
  );
}
