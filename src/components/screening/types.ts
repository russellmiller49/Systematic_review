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
  aiShowScores: boolean;
  aiRankingEnabled: boolean;
  progress: StageProgress;
}

// `ai` block on GET /api/projects/:id — server-side AI feature status for UI gating.
export interface ProjectAiStatus {
  enabled: boolean;
  provider: string;
  screeningModel: string;
  extractionModel: string;
}

export type PrescreenRunStatus = "PENDING" | "SUBMITTED" | "COMPLETED" | "FAILED" | "CANCELED";

export interface PrescreenRun {
  id: string;
  status: PrescreenRunStatus;
  provider: string;
  model: string;
  promptVersion: string;
  totalCount: number;
  succeededCount: number;
  failedCount: number;
  error: string | null;
  usage: { inputTokens: number; outputTokens: number } | null;
  createdAt: string;
  submittedAt: string | null;
  completedAt: string | null;
  requestedBy?: { id: string; name: string };
}

// GET /api/projects/:id/screening/stages/:stageId/prescreen
export interface PrescreenListResponse {
  runs: PrescreenRun[];
  eligible: { unscored: number; unsettled: number };
}

export interface AiSuggestionSummary {
  score: number;
  suggestedDecision: DecisionValue;
  rationale: string;
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
  // Present only when the stage's aiShowScores toggle is on and a suggestion exists.
  aiSuggestion: AiSuggestionSummary | null;
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
