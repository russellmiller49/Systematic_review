// Shapes returned by the full-text API routes — only the fields this UI consumes.
// Sources: src/server/services/fulltext (queue, attempts, upload), screening (stages,
// decisions), protocols (exclusion reasons).

export type RetrievalOutcome = "PENDING" | "RETRIEVED" | "NOT_RETRIEVED";

export type FtOutcome = "INCLUDE" | "EXCLUDE";

export interface QueueFileRef {
  id: string;
  filename: string;
  label: string | null;
}

export interface RetrievalAttempt {
  id: string;
  method: string;
  outcome: RetrievalOutcome;
  notes: string | null;
  attemptedAt: string; // ISO timestamp
  recordedBy: { id: string; name: string };
}

export interface QueueCitation {
  id: string;
  title: string;
  authors?: { family: string; given?: string; raw?: string }[] | null;
  year?: number | null;
  journal?: string | null;
  volume?: string | null;
  issue?: string | null;
  pages?: string | null;
  abstract?: string | null;
  doi?: string | null;
  pmid?: string | null;
}

export interface FullTextQueueItem {
  citation: QueueCitation;
  files: QueueFileRef[];
  latestRetrievalAttempt: RetrievalAttempt | null;
  retrievalStatus: RetrievalOutcome;
  // Materialized full-text stage result; null until the citation settles at FT.
  fullTextResult: {
    outcome: FtOutcome;
    resolvedVia: "CONSENSUS" | "ADJUDICATION" | "SINGLE_REVIEWER";
    resolvedAt: string;
  } | null;
  // Count only — decision content stays blinded server-side.
  fullTextDecisionCount: number;
}

export interface ScreeningStageRef {
  id: string;
  type: "TITLE_ABSTRACT" | "FULL_TEXT";
}

export interface ExclusionReason {
  id: string;
  label: string;
}

// POST /screening/stages/[stageId]/decisions response (decision body omitted — unused here).
export interface DecisionResponse {
  result: { outcome: FtOutcome; resolvedVia: string } | null;
}

// POST /fulltext/files response fields we use.
export interface UploadResult {
  reused: boolean;
  linkCreated: boolean;
}
