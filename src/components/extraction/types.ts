// Shared client-side types + helpers for the extraction pages.
// Interfaces mirror what the API actually returns (src/server/services/extraction and
// src/server/services/studies) — only the fields the UI consumes are modeled.

import type { CitationCardData } from "@/components/citations/citation-card";

export type FieldType =
  | "TEXT"
  | "TEXTAREA"
  | "NUMBER"
  | "DATE"
  | "SINGLE_SELECT"
  | "MULTI_SELECT"
  | "BOOLEAN";

export type TemplateStatus = "DRAFT" | "PUBLISHED" | "ARCHIVED";
export type FormStatus = "IN_PROGRESS" | "COMPLETED";
export type ConflictStatus = "OPEN" | "RESOLVED" | "VOIDED";

export interface FieldOption {
  value: string;
  label: string;
}

export interface TemplateField {
  id: string;
  key: string;
  label: string;
  type: FieldType;
  section?: string | null;
  helpText?: string | null;
  required: boolean;
  options?: unknown; // Json? — read through fieldOptions()
  order: number;
}

export interface Template {
  id: string;
  name: string;
  description?: string | null;
  status: TemplateStatus;
  version: number;
  sourceTemplateId?: string | null;
  createdAt: string;
  fields: TemplateField[];
}

// --- Studies -----------------------------------------------------------------

export interface StudyCitation {
  id: string;
  title: string;
  authors?: CitationCardData["authors"];
  year?: number | null;
  journal?: string | null;
  doi?: string | null;
  pmid?: string | null;
}

export interface StudyReportLink {
  id: string;
  citationId: string;
  isPrimaryReport: boolean;
  citation: StudyCitation;
}

export interface Study {
  id: string;
  label: string;
  notes?: string | null;
  inQuantitativeSynthesis: boolean;
  createdAt: string;
  reportLinks: StudyReportLink[];
  _count?: { extractionForms: number; robAssessments: number };
}

// --- Forms -------------------------------------------------------------------

export interface FormValue {
  id: string;
  formId: string;
  fieldId: string;
  value: unknown;
  sourceQuote?: string | null;
  pageNumber?: number | null;
  notes?: string | null;
}

export interface ExtractionFormData {
  id: string;
  templateId: string;
  studyId: string;
  citationId?: string | null;
  extractorId: string;
  status: FormStatus;
  completedAt?: string | null;
  createdAt: string;
  template: { id: string; name: string; version: number; status: TemplateStatus };
  study: { id: string; label: string };
  extractor: { id: string; name: string };
  values: FormValue[];
}

export interface MyAssignment {
  id: string;
  studyId: string;
  templateId: string;
  study: { id: string; label: string };
  template: { id: string; name: string; version: number };
}

// --- Conflicts ---------------------------------------------------------------

export interface ConflictFormValue {
  formId: string;
  extractor: { id: string; name: string };
  value: unknown;
  sourceQuote?: string | null;
  pageNumber?: number | null;
}

export interface ConflictData {
  id: string;
  templateId: string;
  studyId: string;
  fieldId: string;
  status: ConflictStatus;
  openedAt: string;
  resolvedAt?: string | null;
  field: { id: string; key: string; label: string; type: FieldType; options?: unknown };
  study: { id: string; label: string };
  template: { id: string; name: string; version: number };
  adjudication?: {
    id: string;
    finalValue: unknown;
    reason: string;
    createdAt: string;
    adjudicator: { id: string; name: string };
  } | null;
  forms: ConflictFormValue[];
}

// --- Helpers -----------------------------------------------------------------

export const FIELD_TYPE_LABELS: Record<FieldType, string> = {
  TEXT: "Text",
  TEXTAREA: "Long text",
  NUMBER: "Number",
  DATE: "Date",
  SINGLE_SELECT: "Single select",
  MULTI_SELECT: "Multi select",
  BOOLEAN: "Yes / no",
};

export const SELECT_FIELD_TYPES: readonly FieldType[] = ["SINGLE_SELECT", "MULTI_SELECT"];

// ExtractionField.options arrives as raw JSON — normalize to a typed list.
export function fieldOptions(options: unknown): FieldOption[] {
  if (!Array.isArray(options)) return [];
  return options.filter(
    (o): o is FieldOption =>
      typeof o === "object" &&
      o !== null &&
      typeof (o as FieldOption).value === "string" &&
      typeof (o as FieldOption).label === "string",
  );
}

// Presentation-only formatting of a stored value, typed by its field.
export function formatFieldValue(
  field: { type: FieldType; options?: unknown },
  value: unknown,
): string {
  if (value === null || value === undefined) return "—";
  switch (field.type) {
    case "BOOLEAN":
      return value === true ? "Yes" : value === false ? "No" : String(value);
    case "MULTI_SELECT": {
      if (!Array.isArray(value)) return String(value);
      const opts = fieldOptions(field.options);
      const parts = value.map((v) => opts.find((o) => o.value === v)?.label ?? String(v));
      return parts.length > 0 ? parts.join(", ") : "—";
    }
    case "SINGLE_SELECT": {
      if (typeof value !== "string") return String(value);
      const opts = fieldOptions(field.options);
      return opts.find((o) => o.value === value)?.label ?? value;
    }
    default:
      return typeof value === "object" ? JSON.stringify(value) : String(value);
  }
}

// --- Capability gating -------------------------------------------------------
// UI-gating mirror of the extraction-relevant subset of src/server/permissions/matrix.ts.
// The server stays authoritative — every mutation also handles 403 (ApiError) gracefully.

export type UiCapability =
  | "extraction.templates"
  | "extraction.perform"
  | "extraction.adjudicate"
  | "project.edit";

const CAP_ROLES: Record<UiCapability, readonly string[]> = {
  "extraction.templates": ["OWNER", "ADMIN", "STATISTICIAN"],
  "extraction.perform": ["OWNER", "ADMIN", "EXTRACTOR", "STATISTICIAN", "TRAINEE"],
  "extraction.adjudicate": ["OWNER", "ADMIN", "ADJUDICATOR"],
  "project.edit": ["OWNER", "ADMIN"],
};

export function hasCap(roles: readonly string[] | null | undefined, cap: UiCapability): boolean {
  if (!roles) return false;
  const allowed = CAP_ROLES[cap];
  return roles.some((r) => allowed.includes(r));
}
