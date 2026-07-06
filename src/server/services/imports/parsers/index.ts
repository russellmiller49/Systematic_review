// Citation import parsers — format detection + dispatch. All parsers are pure and never
// throw; every input row becomes either a ParsedRecord or a ParseRowError.
import { parseBibtex } from "./bibtex";
import { parseCsv } from "./csv";
import { parseNbib } from "./nbib";
import { parseRis } from "./ris";
import { preprocess, type ImportFileFormat, type ParseResult } from "./types";

export type {
  ImportFileFormat,
  ParsedAuthor,
  ParsedRecord,
  ParseResult,
  ParseRowError,
} from "./types";
export { parseBibtex } from "./bibtex";
export { parseCsv } from "./csv";
export { parseNbib } from "./nbib";
export { parseRis } from "./ris";

const EXTENSION_FORMATS: Record<string, ImportFileFormat> = {
  ris: "RIS",
  bib: "BIBTEX",
  bibtex: "BIBTEX",
  csv: "CSV",
  nbib: "NBIB",
  medline: "NBIB",
};

// Detect by file extension first, then by sniffing content. Returns null when unsure.
export function detectFormat(filename: string, content: string): ImportFileFormat | null {
  const ext = filename.toLowerCase().match(/\.([a-z0-9]+)$/)?.[1];
  if (ext && EXTENSION_FORMATS[ext]) return EXTENSION_FORMATS[ext];

  const text = preprocess(content).trim();
  if (text.length === 0) return null;
  if (/^PMID- /m.test(text)) return "NBIB";
  if (/^TY  - /m.test(text)) return "RIS";
  if (/^@[A-Za-z]+\s*[{(]/m.test(text)) return "BIBTEX";
  const firstLine = text.split("\n", 1)[0] ?? "";
  if (firstLine.includes(",")) return "CSV";
  return null;
}

export function parse(format: ImportFileFormat, content: string): ParseResult {
  switch (format) {
    case "RIS":
      return parseRis(content);
    case "BIBTEX":
      return parseBibtex(content);
    case "CSV":
      return parseCsv(content);
    case "NBIB":
      return parseNbib(content);
  }
}
