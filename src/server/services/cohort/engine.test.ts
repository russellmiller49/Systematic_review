import { describe, expect, it } from "vitest";
import {
  AUTHOR_OVERLAP_GATE,
  COMPOSITE_THRESHOLD,
  REGISTRY_SCORE,
  detectCohortOverlap,
  type CohortCitationLite,
} from "./engine";

function cite(id: string, over: Partial<CohortCitationLite> = {}): CohortCitationLite {
  return {
    id,
    title: `Placeholder title ${id}`,
    authors: [],
    year: null,
    affiliations: null,
    registryIds: [],
    doi: null,
    studyIds: [],
    ...over,
  };
}

const CRINER_AUTHORS = [
  { family: "Criner", given: "Gerard J." },
  { family: "Sue", given: "Richard" },
  { family: "Wright", given: "Shannon" },
];
// Shares Criner + Sue with CRINER_AUTHORS → author-key Jaccard 2/4 = 0.5.
const FOLLOWUP_AUTHORS = [
  { family: "Criner", given: "Gerard J." },
  { family: "Sue", given: "Richard" },
  { family: "Dransfield", given: "Mark" },
];

describe("cohort engine — tier 1 (registry ids)", () => {
  it("emits a REGISTRY_ID pair at score 0.98 with the shared ids in signals", () => {
    const pairs = detectCohortOverlap([
      cite("a", { registryIds: ["NCT01796392", "EUDRACT2016-001234-56"] }),
      cite("b", { registryIds: ["NCT01796392"] }),
    ]);
    expect(pairs).toHaveLength(1);
    expect(pairs[0]).toMatchObject({
      aId: "a",
      bId: "b",
      method: "REGISTRY_ID",
      score: REGISTRY_SCORE,
    });
    expect(pairs[0]!.signals.registryIds).toEqual(["NCT01796392"]);
  });

  it("does not require author overlap (tier 1 bypasses the composite gate)", () => {
    const pairs = detectCohortOverlap([
      cite("a", { registryIds: ["NCT00000001"], authors: [{ family: "Alpha" }] }),
      cite("b", { registryIds: ["NCT00000001"], authors: [{ family: "Omega" }] }),
    ]);
    expect(pairs).toHaveLength(1);
    expect(pairs[0]!.method).toBe("REGISTRY_ID");
    expect(pairs[0]!.signals.authorOverlap).toBe(0);
  });

  it("tier 1 wins when a pair would also qualify as composite", () => {
    const pairs = detectCohortOverlap([
      cite("a", {
        registryIds: ["NCT00000002"],
        authors: CRINER_AUTHORS,
        year: 2018,
        title: "Valve treatment in the LIBERATE trial",
      }),
      cite("b", {
        registryIds: ["NCT00000002"],
        authors: FOLLOWUP_AUTHORS,
        year: 2019,
        title: "Valve treatment durability: LIBERATE follow-up",
      }),
    ]);
    expect(pairs).toHaveLength(1);
    expect(pairs[0]!.method).toBe("REGISTRY_ID");
    expect(pairs[0]!.score).toBe(REGISTRY_SCORE);
    // composite sub-signals still ride along for the UI
    expect(pairs[0]!.signals.authorOverlap).toBe(0.5);
    expect(pairs[0]!.signals.acronyms).toEqual(["LIBERATE"]);
  });

  it("no shared id → no tier-1 pair", () => {
    const pairs = detectCohortOverlap([
      cite("a", { registryIds: ["NCT00000001"] }),
      cite("b", { registryIds: ["NCT00000002"] }),
    ]);
    expect(pairs).toEqual([]);
  });
});

describe("cohort engine — tier 2 (composite)", () => {
  const A_TITLE = "Endobronchial valve treatment in heterogeneous emphysema outcomes";
  const B_TITLE = "Endobronchial valve treatment in heterogeneous emphysema durability";
  // Rare-token sets: A {endobronchial, valve, treatment, heterogeneous, emphysema},
  // B = A + {durability} → Jaccard 5/6 = 0.8333.

  it("scores the full composite: 0.40·author + 0.20·affiliation + 0.25·title + 0.15·year", () => {
    const pairs = detectCohortOverlap([
      cite("a", {
        title: A_TITLE,
        authors: CRINER_AUTHORS,
        year: 2018,
        affiliations: ["Temple University, Philadelphia, PA, USA"],
      }),
      cite("b", {
        title: B_TITLE,
        authors: FOLLOWUP_AUTHORS,
        year: 2019,
        affiliations: ["Temple University, Philadelphia, PA, USA"],
      }),
    ]);
    expect(pairs).toHaveLength(1);
    const pair = pairs[0]!;
    expect(pair.method).toBe("COMPOSITE");
    expect(pair.signals.authorOverlap).toBe(0.5);
    expect(pair.signals.affiliationSimilarity).toBe(1);
    expect(pair.signals.titleSignal).toBeCloseTo(0.8333, 4);
    expect(pair.signals.yearDelta).toBe(1);
    // 0.4·0.5 + 0.2·1 + 0.25·0.8333 + 0.15·0.75 = 0.7208
    expect(pair.score).toBeCloseTo(0.7208, 4);
  });

  it("drops the affiliation term and renormalizes when either side has none", () => {
    for (const missing of [null, [] as string[]]) {
      const pairs = detectCohortOverlap([
        cite("a", { title: A_TITLE, authors: CRINER_AUTHORS, year: 2018, affiliations: missing }),
        cite("b", {
          title: B_TITLE,
          authors: FOLLOWUP_AUTHORS,
          year: 2018,
          affiliations: ["Temple University, Philadelphia, PA, USA"],
        }),
      ]);
      expect(pairs).toHaveLength(1);
      expect(pairs[0]!.signals.affiliationSimilarity).toBeNull();
      // (0.4·0.5 + 0.25·0.8333 + 0.15·1) / 0.8 = 0.6979
      expect(pairs[0]!.score).toBeCloseTo(0.6979, 4);
    }
  });

  it("drops the year term and renormalizes when a year is missing", () => {
    const pairs = detectCohortOverlap([
      cite("a", {
        title: A_TITLE,
        authors: CRINER_AUTHORS,
        year: null,
        affiliations: ["Temple University, Philadelphia, PA, USA"],
      }),
      cite("b", {
        title: B_TITLE,
        authors: FOLLOWUP_AUTHORS,
        year: 2019,
        affiliations: ["Temple University, Philadelphia, PA, USA"],
      }),
    ]);
    expect(pairs).toHaveLength(1);
    expect(pairs[0]!.signals.yearDelta).toBeNull();
    // (0.4·0.5 + 0.2·1 + 0.25·0.8333) / 0.85 = 0.7157
    expect(pairs[0]!.score).toBeCloseTo(0.7157, 4);
  });

  it("renormalizes to author + title only when affiliation AND year are missing", () => {
    const pairs = detectCohortOverlap([
      cite("a", { title: A_TITLE, authors: CRINER_AUTHORS }),
      cite("b", { title: B_TITLE, authors: FOLLOWUP_AUTHORS }),
    ]);
    expect(pairs).toHaveLength(1);
    // (0.4·0.5 + 0.25·0.8333) / 0.65 = 0.6282
    expect(pairs[0]!.score).toBeCloseTo(0.6282, 4);
  });

  it("a shared trial acronym sets titleSignal to 1", () => {
    const pairs = detectCohortOverlap([
      cite("a", {
        title: "Something entirely different (LIBERATE)",
        authors: CRINER_AUTHORS,
        year: 2018,
      }),
      cite("b", {
        title: "Unrelated wording here too: the LIBERATE cohort",
        authors: FOLLOWUP_AUTHORS,
        year: 2018,
      }),
    ]);
    expect(pairs).toHaveLength(1);
    expect(pairs[0]!.signals.acronyms).toEqual(["LIBERATE"]);
    expect(pairs[0]!.signals.titleSignal).toBe(1);
    // (0.4·0.5 + 0.25·1 + 0.15·1) / 0.8 = 0.75
    expect(pairs[0]!.score).toBeCloseTo(0.75, 4);
  });

  it("GATE: pairs below 0.2 author overlap are never emitted as composite", () => {
    // One shared author among many → Jaccard 1/6 = 0.1667 < gate, despite identical titles.
    const pairs = detectCohortOverlap([
      cite("a", {
        title: A_TITLE,
        year: 2018,
        authors: [
          { family: "Shared", given: "S" },
          { family: "Aone", given: "A" },
          { family: "Atwo", given: "A" },
          { family: "Athree", given: "A" },
        ],
      }),
      cite("b", {
        title: A_TITLE,
        year: 2018,
        authors: [
          { family: "Shared", given: "S" },
          { family: "Bone", given: "B" },
          { family: "Btwo", given: "B" },
        ],
      }),
    ]);
    expect(1 / 6).toBeLessThan(AUTHOR_OVERLAP_GATE);
    expect(pairs).toEqual([]);
  });

  it("THRESHOLD: weak composites below 0.55 are not emitted", () => {
    // author 1/4 = 0.25 (passes gate), disjoint titles, far-apart years, unrelated
    // affiliations → score 0.4·0.25 = 0.1.
    const pairs = detectCohortOverlap([
      cite("a", {
        title: "Alpha bravo charlie delta echo",
        year: 2010,
        affiliations: ["University of Somewhere, Norway"],
        authors: [
          { family: "Shared", given: "S" },
          { family: "Aone", given: "A" },
        ],
      }),
      cite("b", {
        title: "Foxtrot golf hotel india juliet",
        year: 2020,
        affiliations: ["Hospital of Elsewhere, Chile"],
        authors: [
          { family: "Shared", given: "S" },
          { family: "Bone", given: "B" },
          { family: "Btwo", given: "B" },
        ],
      }),
    ]);
    expect(0.1).toBeLessThan(COMPOSITE_THRESHOLD);
    expect(pairs).toEqual([]);
  });

  it("author keys use family + first initial: same surname, different initials ≠ overlap", () => {
    const pairs = detectCohortOverlap([
      cite("a", {
        title: A_TITLE,
        year: 2018,
        authors: [{ family: "Criner", given: "Gerard" }],
      }),
      cite("b", {
        title: A_TITLE,
        year: 2018,
        authors: [{ family: "Criner", given: "Paula" }],
      }),
    ]);
    expect(pairs).toEqual([]); // no shared key → not even a candidate pair
  });

  it("year proximity steps 0/1/2/3/≥4 → 1/0.75/0.5/0.25/0", () => {
    // Full-signal setup where only the year varies: author 1, affiliation 1, title 1.
    const base = {
      title: "Zephyr LIBERATE cohort report",
      authors: [{ family: "Criner", given: "G" }],
      affiliations: ["Temple University"],
    };
    const scoreFor = (yearB: number) => {
      const pairs = detectCohortOverlap([
        cite("a", { ...base, year: 2020 }),
        cite("b", { ...base, title: "Different LIBERATE wording", year: yearB }),
      ]);
      expect(pairs).toHaveLength(1);
      return pairs[0]!.score;
    };
    // score = 0.85 + 0.15·yearProximity
    expect(scoreFor(2020)).toBeCloseTo(1.0, 4);
    expect(scoreFor(2019)).toBeCloseTo(0.9625, 4);
    expect(scoreFor(2018)).toBeCloseTo(0.925, 4);
    expect(scoreFor(2017)).toBeCloseTo(0.8875, 4);
    expect(scoreFor(2016)).toBeCloseTo(0.85, 4);
    expect(scoreFor(2010)).toBeCloseTo(0.85, 4);
  });
});

describe("cohort engine — skips and invariants", () => {
  it("skips pairs already linked to the same study (both tiers)", () => {
    const pairs = detectCohortOverlap([
      cite("a", { registryIds: ["NCT00000009"], studyIds: ["study-1"] }),
      cite("b", { registryIds: ["NCT00000009"], studyIds: ["study-1", "study-2"] }),
    ]);
    expect(pairs).toEqual([]);
  });

  it("skips pairs with an identical non-null DOI (dedup's territory)", () => {
    const pairs = detectCohortOverlap([
      cite("a", { registryIds: ["NCT00000009"], doi: "10.1000/same" }),
      cite("b", { registryIds: ["NCT00000009"], doi: "10.1000/same" }),
    ]);
    expect(pairs).toEqual([]);
    // …but two null DOIs are not "identical"
    const kept = detectCohortOverlap([
      cite("a", { registryIds: ["NCT00000009"], doi: null }),
      cite("b", { registryIds: ["NCT00000009"], doi: null }),
    ]);
    expect(kept).toHaveLength(1);
  });

  it("orders pairs deterministically with aId < bId regardless of input order", () => {
    const input = [
      cite("z", { registryIds: ["NCT00000001"] }),
      cite("m", { registryIds: ["NCT00000001", "NCT00000002"] }),
      cite("a", { registryIds: ["NCT00000002"] }),
    ];
    const pairs = detectCohortOverlap(input);
    const reversed = detectCohortOverlap([...input].reverse());
    expect(pairs.map((p) => [p.aId, p.bId])).toEqual([
      ["a", "m"],
      ["m", "z"],
    ]);
    expect(reversed).toEqual(pairs);
    for (const p of pairs) expect(p.aId < p.bId).toBe(true);
  });

  it("empty population and singleton population → no pairs", () => {
    expect(detectCohortOverlap([])).toEqual([]);
    expect(detectCohortOverlap([cite("a", { registryIds: ["NCT00000001"] })])).toEqual([]);
  });
});
