// Shapes consumed from the screening + exclusion-reason APIs (only the fields the UI uses).

export type StageType = "TITLE_ABSTRACT" | "FULL_TEXT";
export type DecisionValue = "INCLUDE" | "EXCLUDE" | "MAYBE";

export const STAGE_LABELS: Record<StageType, string> = {
  TITLE_ABSTRACT: "Title & abstract",
  FULL_TEXT: "Full text",
};

export interface StageProgress {
  assignedCitations: number;
  decidedCitations: number;
  openConflicts: number;
  results: { total: number; included: number; excluded: number };
}

// GET /api/projects/:id/screening/stages — stage row + team-level progress.
export interface ScreeningStageSummary {
  id: string;
  type: StageType;
  reviewersPerCitation: number;
  blinded: boolean;
  maybeGeneratesConflict: boolean;
  progress: StageProgress;
}

// The citation "card" payload embedded in queue items.
export interface QueueCitation {
  id: string;
  title: string;
  authors: { family: string; given?: string; raw?: string }[] | null;
  year: number | null;
  journal: string | null;
  abstract: string | null;
  doi: string | null;
  pmid: string | null;
  url: string | null;
  sources: string[];
}

export interface QueueItem {
  assignmentId: string;
  citation: QueueCitation;
  // Present only in rare states (e.g. after a reopen) — the queue is my PENDING work.
  myDecision: { decision: DecisionValue } | null;
}

// GET /api/projects/:id/screening/stages/:stageId/queue
export interface QueueResponse {
  stage: { id: string; type: StageType };
  total: number;
  items: QueueItem[];
}

// GET /api/projects/:id/exclusion-reasons?stage=FULL_TEXT
export interface ExclusionReasonOption {
  id: string;
  label: string;
}
