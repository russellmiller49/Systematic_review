// Client-side interfaces for the import API payloads (only the fields the UI consumes).

export type ImportFormat = "RIS" | "BIBTEX" | "CSV" | "NBIB";
export type ImportBatchStatus = "PREVIEWED" | "COMMITTED" | "FAILED";

export interface ImportSourceRow {
  id: string;
  name: string;
  description: string | null;
  createdAt: string;
  _count?: { batches: number };
}

export interface ImportBatchRow {
  id: string;
  filename: string;
  format: ImportFormat;
  status: ImportBatchStatus;
  totalRecords: number;
  parsedRecords: number;
  failedRecords: number;
  committedAt: string | null;
  createdAt: string;
  source: { id: string; name: string };
  // Present on list/detail responses; absent on the create response.
  createdBy?: { id: string; name: string; email: string };
}

export interface ParsedAuthor {
  family: string;
  given?: string;
  raw?: string;
}

export interface ParsedRecordFields {
  title: string;
  authors?: ParsedAuthor[];
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
}

export interface SourceRecordRow {
  id: string;
  rowNumber: number;
  rawRecord: string;
  parsed: ParsedRecordFields | null;
  parseErrors: { message: string }[] | null;
  citationId: string | null;
}

export interface ImportBatchDetail extends ImportBatchRow {
  rows: SourceRecordRow[];
}

export interface CommitResult extends ImportBatchRow {
  citationsCreated: number;
}

export const FORMAT_LABELS: Record<ImportFormat, string> = {
  RIS: "RIS",
  BIBTEX: "BibTeX",
  CSV: "CSV",
  NBIB: "PubMed NBIB",
};

export const BATCH_STATUS_VARIANT: Record<ImportBatchStatus, "maybe" | "include" | "exclude"> = {
  PREVIEWED: "maybe",
  COMMITTED: "include",
  FAILED: "exclude",
};
