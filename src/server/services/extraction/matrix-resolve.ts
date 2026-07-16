// Pure cell-resolution logic for the cross-study extraction matrix. No I/O — unit-tested.
//
// Resolution precedence for a (study, field) cell, mirroring the "final-data consumers must
// prefer adjudicated values" rule:
//   1. ADJUDICATED — a RESOLVED conflict's adjudication finalValue.
//   2. disputed    — an OPEN conflict (or completed forms that disagree) → no resolved value.
//   3. AGREED      — ≥2 COMPLETED forms whose values are valuesEqual.
//   4. SINGLE      — exactly 1 COMPLETED form with a value.
//   5. (empty)     — nothing completed; in-progress entries still show in the cell detail.
// VOIDED conflicts are ignored (treated as no conflict).

import type { FieldType, FormStatus } from "@prisma/client";
import { valuesEqual } from "./validation";

export interface MatrixEntry {
  formId: string;
  extractor: { id: string; name: string };
  formStatus: FormStatus;
  value: unknown;
  sourceQuote: string | null;
  pageNumber: number | null;
  sourceAnchor: unknown;
  updatedAt: Date | string;
}

export type ResolvedSource = "ADJUDICATED" | "AGREED" | "SINGLE";

export interface ResolvedCell {
  resolved: { value: unknown; source: ResolvedSource } | null;
  disputed: boolean;
}

export function resolveMatrixCell(input: {
  fieldType: FieldType;
  entries: MatrixEntry[];
  conflictStatus?: "OPEN" | "RESOLVED" | "VOIDED" | null;
  adjudicatedValue?: unknown; // ExtractionAdjudication.finalValue when the conflict is RESOLVED
}): ResolvedCell {
  if (input.conflictStatus === "RESOLVED" && input.adjudicatedValue !== undefined) {
    return { resolved: { value: input.adjudicatedValue, source: "ADJUDICATED" }, disputed: false };
  }
  if (input.conflictStatus === "OPEN") {
    return { resolved: null, disputed: true };
  }
  const completed = input.entries.filter((e) => e.formStatus === "COMPLETED");
  if (completed.length === 0) return { resolved: null, disputed: false };
  if (completed.length === 1) {
    return { resolved: { value: completed[0]!.value, source: "SINGLE" }, disputed: false };
  }
  const first = completed[0]!;
  const allEqual = completed.every((e) => valuesEqual(input.fieldType, first.value, e.value));
  if (allEqual) {
    return { resolved: { value: first.value, source: "AGREED" }, disputed: false };
  }
  // Disagreeing completed forms without a conflict row yet (evaluation lag) — still disputed.
  return { resolved: null, disputed: true };
}
