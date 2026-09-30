import { describe, expect, it } from "vitest";
import { publicationInfo } from "./publication";
import { parse, type ImportFileFormat } from "../imports/parsers";
import { hasConferencePublicationPair } from "@/lib/dedup-publication";

const fixtures: [ImportFileFormat, string, string][] = [
  ["RIS", "TY  - JOUR\nTI  - Trial results\nM3  - Conference Abstract\nER  -", "conference"],
  ["RIS", "TY  - CPAPER\nTI  - Trial results\nER  -", "conference"],
  ["NBIB", "PMID- 12345\nTI  - Trial results\nPT  - Journal Article\nPT  - Congress", "conference"],
  ["NBIB", "PMID- 12345\nTI  - Trial results\nPT  - Journal Article", "journal"],
  ["RIS", "TY  - JOUR\nTI  - Trial results\nM3  - Article\nER  -", "journal"],
  ["BIBTEX", "@inproceedings{trial, title={Trial results}}", "conference"],
  ["BIBTEX", "@article{trial, title={Trial results}}", "journal"],
  ["CSV", "Title,Document Type\nTrial results,Conference Abstract", "conference"],
  [
    "CSV",
    'Title,Publication Types\nTrial results,"Journal Article;Randomized Controlled Trial"',
    "journal",
  ],
];

describe("imported publication metadata", () => {
  it.each(fixtures)("preserves %s publication types for %s", (format, rawRecord, kind) => {
    const record = parse(format, rawRecord).records[0]!;
    expect(record.publicationTypes?.length).toBeGreaterThan(0);
    const result = publicationInfo([
      {
        rawRecord,
        parsed: record,
        batch: { format, source: { name: "Imported database" } },
      },
    ]);
    expect(result.kind).toBe(kind);
    expect(result.sources).toEqual(["Imported database"]);
  });

  it.each(fixtures.filter(([format]) => format !== "CSV"))(
    "recognizes legacy %s imports without reparsing the whole batch",
    (format, rawRecord, kind) => {
      expect(
        publicationInfo([
          {
            rawRecord,
            parsed: { title: "Trial results" },
            batch: { format, source: { name: "Embase" } },
          },
        ]).kind,
      ).toBe(kind);
    },
  );

  it("does not infer publication type from a PMID, abstract prose, or source name", () => {
    expect(
      publicationInfo([
        {
          rawRecord:
            "PMID- 12345\nTI  - Trial results\nAB  - This conference abstract was expanded into a journal article.",
          parsed: null,
          batch: { format: "NBIB", source: { name: "PubMed" } },
        },
      ]).kind,
    ).toBe("unknown");
    expect(publicationInfo([]).kind).toBe("unknown");
  });

  it("does not mislabel consensus conference guidance as a conference abstract", () => {
    expect(
      publicationInfo([
        {
          rawRecord: "",
          parsed: {
            publicationTypes: ["Journal Article", "Consensus Development Conference"],
          },
          batch: { format: "NBIB", source: { name: "PubMed" } },
        },
      ]).kind,
    ).toBe("journal");
  });

  it("keeps old CSV rows without headers unknown", () => {
    expect(
      publicationInfo([
        {
          rawRecord: "Trial results,Conference Abstract",
          parsed: { title: "Trial results" },
          batch: { format: "CSV", source: { name: "Embase" } },
        },
      ]).kind,
    ).toBe("unknown");
  });

  it("flags only mixed conference/journal groups in either order, including nonadjacent members", () => {
    const citation = (kind: "conference" | "journal" | "unknown") => ({
      publication: { kind, types: [], sources: [] },
    });
    expect(hasConferencePublicationPair([citation("conference"), citation("journal")])).toBe(true);
    expect(hasConferencePublicationPair([citation("journal"), {}, citation("conference")])).toBe(
      true,
    );
    expect(hasConferencePublicationPair([citation("conference"), citation("unknown")])).toBe(false);
    expect(hasConferencePublicationPair([citation("conference"), citation("conference")])).toBe(
      false,
    );
    expect(hasConferencePublicationPair([citation("journal"), citation("journal")])).toBe(false);
  });
});
