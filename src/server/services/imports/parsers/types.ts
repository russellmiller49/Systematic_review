// Shared parser contract for citation import files.
// Parsers are PURE functions and NEVER throw: malformed input becomes per-row error
// entries so the import flow can preserve every source row (CitationSourceRecord).

export interface ParsedAuthor {
  family: string;
  given?: string;
  raw?: string;
}

export interface ParsedRecord {
  title: string;
  authors: ParsedAuthor[];
  year?: number;
  journal?: string;
  volume?: string;
  issue?: string;
  pages?: string;
  abstract?: string;
  doi?: string;
  pmid?: string;
  url?: string;
  language?: string;
  rawChunk: string;
  rowNumber: number;
}

export interface ParseRowError {
  rowNumber: number;
  message: string;
  rawChunk: string;
}

export interface ParseResult {
  records: ParsedRecord[];
  errors: ParseRowError[];
}

// Mirrors the Prisma ImportFormat enum values (parsers stay Prisma-free / pure).
export type ImportFileFormat = "RIS" | "BIBTEX" | "CSV" | "NBIB";

// Strip a UTF-8 BOM and normalize CRLF / bare CR line endings to LF.
export function preprocess(content: string): string {
  return content.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");
}

// First plausible publication year in a free-form date value ("2019/05/12", "2020 May").
export function extractYear(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const m = value.match(/\b(1[5-9]\d{2}|2\d{3})\b/);
  return m ? Number(m[1]) : undefined;
}

export function emptyFileResult(): ParseResult {
  return {
    records: [],
    errors: [{ rowNumber: 1, message: "File is empty", rawChunk: "" }],
  };
}
