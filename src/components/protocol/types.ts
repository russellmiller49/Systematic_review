// Shared types + tiny helpers for the protocol UI.
// Interfaces mirror only the fields this page consumes from
// /api/projects/[projectId]/protocol/** and /api/projects/[projectId]/exclusion-reasons/**.

import { api } from "@/lib/api";

export interface UserRef {
  id: string;
  name: string;
  email: string;
}

export type CriterionType = "INCLUSION" | "EXCLUSION";
export type OutcomeType = "PRIMARY" | "SECONDARY";
export type ReasonStage = "TITLE_ABSTRACT" | "FULL_TEXT" | "BOTH";

export interface PicoRow {
  id: string;
  order: number;
  question: string;
  population: string | null;
  intervention: string | null;
  comparator: string | null;
  outcome: string | null;
}

export interface CriterionRow {
  id: string;
  type: CriterionType;
  category: string | null;
  text: string;
  order: number;
}

export interface OutcomeRow {
  id: string;
  name: string;
  type: OutcomeType;
  measure: string | null;
  timepoint: string | null;
  order: number;
}

// GET /protocol → full protocol + children (+ latestVersionNumber; 0 = never published).
export interface ProtocolDetail {
  id: string;
  projectId: string;
  background: string | null;
  reviewQuestion: string | null;
  population: string | null;
  intervention: string | null;
  comparator: string | null;
  outcomesNarrative: string | null;
  studyDesigns: string[];
  setting: string | null;
  dateRestrictionFrom: number | null;
  dateRestrictionTo: number | null;
  languageRestrictions: string[];
  databases: string[];
  grayLiteratureSources: string[];
  searchStrategyNotes: string | null;
  subgroupAnalysisPlan: string | null;
  sensitivityAnalysisPlan: string | null;
  metaAnalysisPlan: string | null;
  gradePlan: string | null;
  updatedAt: string;
  picoQuestions: PicoRow[];
  criteria: CriterionRow[];
  outcomes: OutcomeRow[];
  latestVersionNumber: number;
}

// GET /protocol/versions row.
export interface VersionRow {
  id: string;
  versionNumber: number;
  snapshot: unknown;
  createdAt: string;
  createdBy: UserRef;
}

// GET /protocol/amendments row. fromVersion 0 = change made while still an unpublished draft.
export interface AmendmentRow {
  id: string;
  fromVersion: number;
  toVersion: number;
  reason: string;
  description: string | null;
  createdAt: string;
  createdBy: UserRef;
}

export interface ExclusionReasonRow {
  id: string;
  label: string;
  stage: ReasonStage;
  order: number;
  isActive: boolean;
}

// Optional fields the API requires on protocol changes once screening has begun.
export interface AmendmentFields {
  amendmentReason?: string;
  amendmentDescription?: string;
}

// DELETE with a JSON body — apiDelete has no body support, but protocol child deletes
// must carry amendmentReason once screening has begun (parseOptionalBody server-side).
export function apiDeleteWithBody<T>(path: string, fields: AmendmentFields): Promise<T> {
  return api<T>(path, { method: "DELETE", body: JSON.stringify(fields) });
}

export function toNullableText(value: string): string | null {
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

// "" → omit (undefined); otherwise must be a non-negative integer.
export function parseOrder(
  value: string,
): { ok: true; order: number | undefined } | { ok: false } {
  const trimmed = value.trim();
  if (!trimmed) return { ok: true, order: undefined };
  const n = Number(trimmed);
  if (!Number.isInteger(n) || n < 0) return { ok: false };
  return { ok: true, order: n };
}
