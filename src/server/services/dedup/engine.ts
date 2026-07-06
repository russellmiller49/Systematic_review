// PURE deduplication engine — no I/O, no Prisma. The service (index.ts) feeds it the
// project's ACTIVE citations and persists the pairs it returns. Unit-tested in engine.test.ts.
//
// Two passes:
//  1. Exact — group by normalized DOI / PMID / normalized title → pairs with score 1.
//  2. Fuzzy — blocked candidate pairs (year ±1 OR shared first-8-chars of normalizedTitle)
//     scored on a weighted composite of title/author/year/journal similarity.
// When both passes fire for the same pair the exact method wins (DOI > PMID > title).

import {
  authorOverlap,
  normalizeDoi,
  normalizePmid,
  normalizeTitle,
  type AuthorName,
} from "@/server/services/citations/normalize";
import { jaroWinkler } from "./similarity";

export type DedupEngineMethod = "EXACT_DOI" | "EXACT_PMID" | "NORMALIZED_TITLE" | "FUZZY";

export type CitationLite = {
  id: string;
  normalizedTitle: string;
  doi: string | null;
  pmid: string | null;
  year: number | null;
  journal: string | null;
  authors: AuthorName[];
};

// Human-readable evidence persisted to DeduplicationCandidate.reasons.
export type PairEvidence = {
  titleSimilarity: number;
  authorOverlap: number;
  yearMatch: boolean;
  journalMatch: boolean;
  matchedOn: string[];
};

export type DedupPair = {
  aId: string; // invariant: aId < bId
  bId: string;
  method: DedupEngineMethod;
  score: number; // 1.0 for exact methods, composite for FUZZY
  reasons: PairEvidence;
};

export const FUZZY_COMPOSITE_THRESHOLD = 0.75;
export const FUZZY_TITLE_THRESHOLD = 0.82;
export const TITLE_BLOCK_PREFIX_LENGTH = 8;

const WEIGHTS = { title: 0.55, author: 0.25, year: 0.12, journal: 0.08 } as const;

const round4 = (x: number) => Math.round(x * 10000) / 10000;

const orderPair = (x: string, y: string): [string, string] => (x < y ? [x, y] : [y, x]);
const pairKey = (aId: string, bId: string) => `${aId}|${bId}`;

function journalsMatch(a: CitationLite, b: CitationLite): boolean {
  if (!a.journal || !b.journal) return false;
  return normalizeTitle(a.journal) === normalizeTitle(b.journal);
}

function buildEvidence(a: CitationLite, b: CitationLite, matchedOn: string[]): PairEvidence {
  return {
    titleSimilarity: round4(jaroWinkler(a.normalizedTitle, b.normalizedTitle)),
    authorOverlap: round4(authorOverlap(a.authors, b.authors)),
    yearMatch: a.year !== null && b.year !== null && a.year === b.year,
    journalMatch: journalsMatch(a, b),
    matchedOn,
  };
}

export function detectDuplicates(citations: CitationLite[]): DedupPair[] {
  const byId = new Map(citations.map((c) => [c.id, c]));
  const found = new Map<string, DedupPair>();

  // ---------------------------------------------------------------- exact pass
  const exactPasses: Array<{
    method: DedupEngineMethod;
    field: string;
    keyOf: (c: CitationLite) => string | null;
  }> = [
    { method: "EXACT_DOI", field: "doi", keyOf: (c) => normalizeDoi(c.doi) },
    { method: "EXACT_PMID", field: "pmid", keyOf: (c) => normalizePmid(c.pmid) },
    {
      method: "NORMALIZED_TITLE",
      field: "normalizedTitle",
      keyOf: (c) => (c.normalizedTitle.trim().length > 0 ? c.normalizedTitle.trim() : null),
    },
  ];

  for (const pass of exactPasses) {
    const buckets = new Map<string, CitationLite[]>();
    for (const c of citations) {
      const key = pass.keyOf(c);
      if (!key) continue;
      const bucket = buckets.get(key);
      if (bucket) bucket.push(c);
      else buckets.set(key, [c]);
    }
    for (const bucket of buckets.values()) {
      if (bucket.length < 2) continue;
      for (let i = 0; i < bucket.length; i++) {
        for (let j = i + 1; j < bucket.length; j++) {
          const [aId, bId] = orderPair(bucket[i]!.id, bucket[j]!.id);
          const key = pairKey(aId, bId);
          const existing = found.get(key);
          if (existing) {
            // Higher-priority exact method already claimed the pair; record the extra field.
            if (!existing.reasons.matchedOn.includes(pass.field)) {
              existing.reasons.matchedOn.push(pass.field);
            }
            continue;
          }
          const a = byId.get(aId)!;
          const b = byId.get(bId)!;
          found.set(key, {
            aId,
            bId,
            method: pass.method,
            score: 1,
            reasons: buildEvidence(a, b, [pass.field]),
          });
        }
      }
    }
  }

  // ------------------------------------------------------ fuzzy pass (blocked)
  // Candidate pairs share year ±1 OR the first 8 chars of normalizedTitle.
  const candidateKeys = new Set<string>();
  const addBlockPairs = (list: CitationLite[]) => {
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        const [aId, bId] = orderPair(list[i]!.id, list[j]!.id);
        candidateKeys.add(pairKey(aId, bId));
      }
    }
  };

  const byYear = new Map<number, CitationLite[]>();
  for (const c of citations) {
    if (c.year === null) continue;
    const bucket = byYear.get(c.year);
    if (bucket) bucket.push(c);
    else byYear.set(c.year, [c]);
  }
  for (const [year, list] of byYear) {
    addBlockPairs(list);
    const next = byYear.get(year + 1);
    if (!next) continue;
    for (const a of list) {
      for (const b of next) {
        const [aId, bId] = orderPair(a.id, b.id);
        candidateKeys.add(pairKey(aId, bId));
      }
    }
  }

  const byPrefix = new Map<string, CitationLite[]>();
  for (const c of citations) {
    const prefix = c.normalizedTitle.slice(0, TITLE_BLOCK_PREFIX_LENGTH);
    if (!prefix) continue;
    const bucket = byPrefix.get(prefix);
    if (bucket) bucket.push(c);
    else byPrefix.set(prefix, [c]);
  }
  for (const list of byPrefix.values()) addBlockPairs(list);

  for (const key of candidateKeys) {
    if (found.has(key)) continue; // exact method wins for this pair
    const [aId, bId] = key.split("|") as [string, string];
    const a = byId.get(aId)!;
    const b = byId.get(bId)!;

    const titleSimilarity = jaroWinkler(a.normalizedTitle, b.normalizedTitle);
    if (titleSimilarity < FUZZY_TITLE_THRESHOLD) continue;

    const authorScore = authorOverlap(a.authors, b.authors);
    const yearScore =
      a.year === null || b.year === null
        ? 0
        : a.year === b.year
          ? 1
          : Math.abs(a.year - b.year) === 1
            ? 0.5
            : 0;
    const journalScore = journalsMatch(a, b) ? 1 : 0;

    const composite =
      WEIGHTS.title * titleSimilarity +
      WEIGHTS.author * authorScore +
      WEIGHTS.year * yearScore +
      WEIGHTS.journal * journalScore;
    if (composite < FUZZY_COMPOSITE_THRESHOLD) continue;

    found.set(key, {
      aId,
      bId,
      method: "FUZZY",
      score: round4(composite),
      reasons: {
        titleSimilarity: round4(titleSimilarity),
        authorOverlap: round4(authorScore),
        yearMatch: yearScore === 1,
        journalMatch: journalScore === 1,
        matchedOn: ["fuzzy"],
      },
    });
  }

  return [...found.values()].sort((p, q) =>
    p.aId === q.aId ? (p.bId < q.bId ? -1 : 1) : p.aId < q.aId ? -1 : 1,
  );
}
