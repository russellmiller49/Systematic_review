import { describe, expect, it } from "vitest";
import { metadataConflicts, clusterMetadataConflicts, type ConflictCitation } from "./conflicts";
import { detectDuplicates } from "./engine";

const a: ConflictCitation = {
  normalizedTitle: "airway stenting outcomes in adults with malignant fistulas",
  doi: "10.1234/a",
  pmid: "1234",
  year: 2018,
  authors: [{ family: "Smith" }],
};
describe("imported metadata conflict signals", () => {
  it("flags shared DOI / different PMIDs and shared PMID / different DOIs", () => {
    expect(metadataConflicts(a, { ...a, pmid: "5678" })).toEqual(["Same DOI but different PMIDs"]);
    expect(metadataConflicts(a, { ...a, doi: "10.1234/b" })).toEqual([
      "Same PMID but different DOIs",
    ]);
  });
  it("normalizes identifiers and does not warn about missing or compatible metadata", () => {
    expect(
      metadataConflicts(a, {
        ...a,
        doi: "https://doi.org/10.1234/A",
        pmid: "PMID: 1234",
      }),
    ).toEqual([]);
    expect(
      metadataConflicts(a, {
        ...a,
        doi: null,
        pmid: null,
        year: null,
        authors: [],
      }),
    ).toEqual([]);
    expect(
      metadataConflicts(a, {
        ...a,
        year: 2019,
        normalizedTitle: `${a.normalizedTitle} study`,
      }),
    ).toEqual([]);
  });
  it("requires substantial title, author AND year disagreement for the bibliographic rule", () => {
    const b = {
      ...a,
      pmid: null,
      normalizedTitle: "zinc supplements for prevention of childhood diarrhea",
      authors: [{ family: "Jones" }],
      year: 2010,
    };
    expect(metadataConflicts(a, b)).toEqual([
      "Matching identifier but strong title, author, and year disagreement",
    ]);
    for (const compatible of [
      { ...b, year: 2018 },
      { ...b, authors: [] },
      { ...b, normalizedTitle: a.normalizedTitle },
    ]) {
      expect(metadataConflicts(a, compatible)).toEqual([]);
    }
    expect(metadataConflicts(a, { ...b, doi: null })).toEqual([]);
  });
  it("finds contradictions between nonadjacent members across missing metadata", () => {
    expect(clusterMetadataConflicts([a, { ...a, pmid: null }, { ...a, pmid: "5678" }])).toEqual([
      "Same DOI but different PMIDs",
    ]);
  });
  it("keeps exact DOI candidate evidence even when metadata conflicts", () => {
    const pairs = detectDuplicates([
      { ...a, id: "a", journal: null, authors: [{ family: "Smith" }] },
      {
        ...a,
        id: "b",
        journal: null,
        authors: [{ family: "Smith" }],
        pmid: "5678",
      },
    ]);
    expect(pairs[0]).toMatchObject({ method: "EXACT_DOI", score: 1 });
  });
});
