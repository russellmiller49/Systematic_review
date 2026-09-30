import type { DedupPublication } from "@/lib/dedup-publication";
import { parse, type ImportFileFormat } from "../imports/parsers";

export const publicationSourceSelect = {
  rawRecord: true,
  parsed: true,
  batch: { select: { format: true, source: { select: { name: true } } } },
} as const;

interface SourceRecord {
  rawRecord: string;
  parsed: unknown;
  batch: { format: ImportFileFormat; source: { name: string } };
}

// Use explicit publication-type metadata, never abstract length, PMID presence, or
// mentions of a conference in article prose. Conference tags override generic JOUR.
export function publicationInfo(sourceRecords: SourceRecord[]): DedupPublication {
  const types = new Set<string>();
  const sources = new Set<string>();
  for (const source of sourceRecords) {
    sources.add(source.batch.source.name);
    const saved =
      source.parsed && typeof source.parsed === "object"
        ? (source.parsed as { publicationTypes?: unknown }).publicationTypes
        : undefined;
    // Existing RIS/NBIB/BibTeX imports retain the complete record, so no reimport is
    // needed. Old CSV rows lack their header and cannot be reliably reinterpreted.
    const values = Array.isArray(saved)
      ? saved
      : source.batch.format !== "CSV"
        ? (parse(source.batch.format, source.rawRecord).records[0]?.publicationTypes ?? [])
        : [];
    for (const value of values) {
      if (typeof value === "string" && value.trim()) types.add(value.trim());
    }
  }
  const normalized = [...types].flatMap((value) =>
    value
      .toLowerCase()
      .split(/[;|]/)
      .map((v) => v.trim()),
  );
  const conference = normalized.some((value) =>
    /^(?:conf|cpaper|conference|inproceedings|proceedings|congress(?:es)?|meeting abstract|conference (?:abstract|paper|proceedings|review)|congress abstract)s?$/.test(
      value,
    ),
  );
  const journal = normalized.some((value) =>
    /^(?:jour|jfull|article|journal article|research article|original article|full length article)$/.test(
      value,
    ),
  );
  return {
    kind: conference ? "conference" : journal ? "journal" : "unknown",
    types: [...types],
    sources: [...sources],
  };
}
