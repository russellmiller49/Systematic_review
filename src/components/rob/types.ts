// Shared client-side types for the risk-of-bias pages. Interfaces model ONLY the
// fields this UI consumes; optional/nullable fields mirror what the API may omit.

export interface JudgmentScaleEntry {
  value: string;
  label: string;
  color?: string;
  severity?: number;
}

export interface RobQuestion {
  id: string;
  domainId: string;
  text: string;
  guidance?: string | null;
  order: number;
  // JSON column — validated server-side as string[]; guard with asStringArray().
  allowedAnswers: unknown;
}

export interface RobDomain {
  id: string;
  toolId: string;
  name: string;
  guidance?: string | null;
  order: number;
  questions: RobQuestion[];
}

export type ToolStatus = "DRAFT" | "PUBLISHED" | "ARCHIVED";

export interface RobTool {
  id: string;
  projectId: string | null;
  name: string;
  description: string | null;
  isBuiltin: boolean;
  status: ToolStatus;
  // JSON column — guard with getScale().
  judgmentScale: unknown;
  createdAt: string;
  domains: RobDomain[];
}

export interface RobJudgmentRow {
  id: string;
  domainId: string;
  judgment: string;
  support?: string | null;
  notes?: string | null;
}

export interface RobResponseRow {
  id: string;
  questionId: string;
  answer: string;
  note?: string | null;
}

export type AssessmentStatus = "IN_PROGRESS" | "COMPLETED";

export interface RobAssessment {
  id: string;
  toolId: string;
  studyId: string;
  assessorId: string;
  status: AssessmentStatus;
  overallJudgment: string | null;
  completedAt: string | null;
  createdAt: string;
  tool: { id: string; name: string; judgmentScale: unknown };
  study: { id: string; label: string };
  assessor: { id: string; name: string };
  judgments: RobJudgmentRow[];
  responses: RobResponseRow[];
}

export type AssignmentStatus = "PENDING" | "COMPLETED" | "VOIDED";

export interface RobAssignment {
  id: string;
  toolId: string;
  studyId: string;
  assessorId: string;
  status: AssignmentStatus;
  createdAt: string;
  tool: { id: string; name: string; isBuiltin: boolean };
  study: { id: string; label: string };
  assessor: { id: string; name: string };
}

export type ConflictStatus = "OPEN" | "RESOLVED" | "VOIDED";

export interface RobConflictAssessor {
  userId: string;
  name: string;
  judgment: string | null;
  support: string | null;
}

export interface RobAdjudication {
  id: string;
  finalJudgment: string;
  reason: string;
  createdAt: string;
  adjudicator: { id: string; name: string };
}

export interface RobConflict {
  id: string;
  toolId: string;
  studyId: string;
  domainId: string | null;
  domainName: string;
  status: ConflictStatus;
  openedAt: string;
  resolvedAt: string | null;
  tool: { id: string; name: string };
  study: { id: string; label: string };
  assessors: RobConflictAssessor[];
  adjudication: RobAdjudication | null;
}

export interface StudyRow {
  id: string;
  label: string;
}

export interface MemberRow {
  id: string;
  roles: string[];
  status: string;
  user: { id: string; name: string; email: string };
}

// --- AI suggestions ------------------------------------------------------------

// `ai` block on GET /api/projects/:id — server-side AI feature status for UI gating.
export interface ProjectAiStatus {
  enabled: boolean;
  provider: string;
  screeningModel: string;
  extractionModel: string;
}

export interface RobSuggestionQuote {
  text: string;
  page: number | null;
}

export interface RobSignalingAnswerData {
  questionId: string;
  answer: string;
  quote: string | null;
  page: number | null;
  invalidReason?: string;
}

export interface RobSuggestionData {
  id: string;
  domainId: string;
  suggestedJudgment: string | null;
  rationale: string;
  // JSON columns — shaped by the ingest service; guard with the as* helpers below.
  quotes: unknown;
  signalingAnswers: unknown;
  confidence: number | null;
  notFound: boolean;
  invalidReason: string | null;
  provider: string;
  model: string;
  domain: { id: string; name: string; order: number };
}

export interface AiRobRunData {
  id: string;
  status: "PENDING" | "SUBMITTED" | "COMPLETED" | "FAILED" | "CANCELED";
  totalDomains: number;
  suggestedCount: number;
  invalidCount: number;
  notFoundCount: number;
  error?: string | null;
  createdAt: string;
  requestedBy?: { id: string; name: string };
}

export interface RobSuggestionsResponse {
  suggestions: RobSuggestionData[];
  latestRun: AiRobRunData | null;
  pdf: { fileId: string; filename: string; sizeBytes: number } | null;
}

export function asQuotes(v: unknown): RobSuggestionQuote[] {
  if (!Array.isArray(v)) return [];
  return v.filter(
    (q): q is RobSuggestionQuote =>
      q !== null && typeof q === "object" && typeof (q as { text?: unknown }).text === "string",
  );
}

export function asSignalingAnswers(v: unknown): RobSignalingAnswerData[] {
  if (!Array.isArray(v)) return [];
  return v.filter(
    (a): a is RobSignalingAnswerData =>
      a !== null &&
      typeof a === "object" &&
      typeof (a as { questionId?: unknown }).questionId === "string" &&
      typeof (a as { answer?: unknown }).answer === "string",
  );
}

// ---------------------------------------------------------------------------
// Judgment-scale helpers — the scale is data-driven JSON, so guard defensively.
// ---------------------------------------------------------------------------

export const FALLBACK_COLOR = "#64748b";

export function getScale(judgmentScale: unknown): JudgmentScaleEntry[] {
  if (!Array.isArray(judgmentScale)) return [];
  const entries: JudgmentScaleEntry[] = [];
  for (const raw of judgmentScale) {
    if (raw && typeof raw === "object" && typeof (raw as { value?: unknown }).value === "string") {
      const e = raw as { value: string; label?: unknown; color?: unknown; severity?: unknown };
      entries.push({
        value: e.value,
        label: typeof e.label === "string" ? e.label : e.value,
        color: typeof e.color === "string" ? e.color : undefined,
        severity: typeof e.severity === "number" ? e.severity : undefined,
      });
    }
  }
  return entries;
}

export function scaleEntryFor(
  scale: JudgmentScaleEntry[],
  value: string | null | undefined,
): JudgmentScaleEntry | undefined {
  if (!value) return undefined;
  return scale.find((e) => e.value === value);
}

export function asStringArray(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
}

// ---------------------------------------------------------------------------
// Capability gating — UI convenience ONLY (the server always enforces).
// Mirrors the rob-relevant rows of the server permission matrix, applied to the
// myRoles array the project API returns.
// ---------------------------------------------------------------------------

export type RobCapability = "rob.tools" | "rob.assess" | "rob.adjudicate" | "project.edit";

const CAP_ROLES: Record<RobCapability, readonly string[]> = {
  "rob.tools": ["OWNER", "ADMIN", "STATISTICIAN"],
  "rob.assess": ["OWNER", "ADMIN", "EXTRACTOR", "STATISTICIAN", "TRAINEE"],
  "rob.adjudicate": ["OWNER", "ADMIN", "ADJUDICATOR"],
  "project.edit": ["OWNER", "ADMIN"],
};

export function hasCap(roles: readonly string[] | null | undefined, cap: RobCapability): boolean {
  return Array.isArray(roles) && roles.some((r) => CAP_ROLES[cap].includes(r));
}

/** True when a member's roles allow them to be assigned as an assessor (rob.assess). */
export function rolesCanAssess(roles: readonly string[]): boolean {
  return roles.some((r) => CAP_ROLES["rob.assess"].includes(r));
}
