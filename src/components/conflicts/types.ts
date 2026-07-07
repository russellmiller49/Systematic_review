// Shared types for the conflicts / adjudication page. These model exactly what
// GET /api/projects/[projectId]/conflicts returns (screening service listConflicts).

import type { CitationCardData } from "@/components/citations/citation-card";

export type StageType = "TITLE_ABSTRACT" | "FULL_TEXT";
export type ConflictStatus = "OPEN" | "RESOLVED" | "VOIDED";
export type DecisionValue = "INCLUDE" | "EXCLUDE" | "MAYBE" | "UNRESOLVED";

export interface ConflictDecision {
  id: string;
  decision: DecisionValue;
  notes?: string | null;
  labels?: string[];
  flaggedForDiscussion?: boolean;
  createdAt: string;
  // Reviewer identity is only returned to users allowed to see it.
  reviewer?: { id: string; name: string } | null;
  exclusionReason?: { id: string; label: string } | null;
}

export interface ConflictAdjudication {
  id: string;
  finalDecision: DecisionValue;
  reason: string;
  createdAt: string;
  adjudicator?: { id: string; name: string } | null;
  exclusionReason?: { id: string; label: string } | null;
}

export interface ConflictRow {
  id: string;
  status: ConflictStatus;
  openedAt: string;
  resolvedAt?: string | null;
  stage: { id: string; type: StageType };
  citation: CitationCardData;
  // May be absent/empty when the server withholds decisions from the current user.
  decisions?: ConflictDecision[];
  adjudication?: ConflictAdjudication | null;
}

export interface EligibilityCriterion {
  id: string;
  type: "INCLUSION" | "EXCLUSION";
  category?: string | null;
  text: string;
}

export interface ConflictListResponse {
  conflicts: ConflictRow[];
  criteria: EligibilityCriterion[];
}

export interface ExclusionReasonOption {
  id: string;
  label: string;
}

export const STAGE_LABELS: Record<StageType, string> = {
  TITLE_ABSTRACT: "Title / abstract",
  FULL_TEXT: "Full text",
};

export const DECISION_BADGE_VARIANT: Record<
  DecisionValue,
  "include" | "exclude" | "maybe" | "muted"
> = {
  INCLUDE: "include",
  EXCLUDE: "exclude",
  MAYBE: "maybe",
  UNRESOLVED: "muted",
};

export const CONFLICT_STATUS_BADGE_VARIANT: Record<
  ConflictStatus,
  "maybe" | "secondary" | "muted"
> = {
  OPEN: "maybe",
  RESOLVED: "secondary",
  VOIDED: "muted",
};
