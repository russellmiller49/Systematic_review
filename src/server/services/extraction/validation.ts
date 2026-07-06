// Pure typed-value validation and comparison for extraction fields.
// No I/O — unit-testable in isolation (see validation.test.ts).

import type { FieldType } from "@prisma/client";
import { validationError } from "@/server/errors";

// Type alias (not interface) so FieldOption[] structurally satisfies Prisma.InputJsonValue.
export type FieldOption = {
  value: string;
  label: string;
};

// ExtractionField.options is Json?; normalize to a typed list (empty when absent/malformed).
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

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// Validates a client-supplied (non-null) value against the field's type.
// Throws AppError(VALIDATION) with a field-specific message; returns the value on success.
export function validateFieldValue(
  field: { key: string; type: FieldType; options: unknown },
  value: unknown,
): unknown {
  const fail = (expected: string) =>
    validationError(`Invalid value for field "${field.key}": ${expected}`);

  switch (field.type) {
    case "TEXT":
    case "TEXTAREA": {
      if (typeof value !== "string") throw fail("expected a string");
      return value;
    }
    case "NUMBER": {
      if (typeof value !== "number" || !Number.isFinite(value)) {
        throw fail("expected a finite number");
      }
      return value;
    }
    case "DATE": {
      if (typeof value !== "string" || !DATE_RE.test(value)) {
        throw fail("expected a date string in yyyy-mm-dd format");
      }
      const parsed = new Date(`${value}T00:00:00.000Z`);
      if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) {
        throw fail("expected a real calendar date in yyyy-mm-dd format");
      }
      return value;
    }
    case "BOOLEAN": {
      if (typeof value !== "boolean") throw fail("expected a boolean");
      return value;
    }
    case "SINGLE_SELECT": {
      const allowed = fieldOptions(field.options).map((o) => o.value);
      if (typeof value !== "string" || !allowed.includes(value)) {
        throw fail(`expected one of: ${allowed.join(", ")}`);
      }
      return value;
    }
    case "MULTI_SELECT": {
      const allowed = fieldOptions(field.options).map((o) => o.value);
      if (!Array.isArray(value) || value.length === 0) {
        throw fail("expected a non-empty array of option values");
      }
      for (const v of value) {
        if (typeof v !== "string" || !allowed.includes(v)) {
          throw fail(`expected values from: ${allowed.join(", ")}`);
        }
      }
      if (new Set(value).size !== value.length) {
        throw fail("duplicate option values are not allowed");
      }
      return value;
    }
  }
}

// Conflict-detection comparison: JSON deep-equal; MULTI_SELECT is order-insensitive;
// a missing value (undefined) is treated as null.
export function valuesEqual(type: FieldType, a: unknown, b: unknown): boolean {
  const na = a === undefined ? null : a;
  const nb = b === undefined ? null : b;
  if (na === null || nb === null) return na === nb;
  if (type === "MULTI_SELECT" && Array.isArray(na) && Array.isArray(nb)) {
    if (na.length !== nb.length) return false;
    const sa = [...na].map(String).sort();
    const sb = [...nb].map(String).sort();
    return sa.every((v, i) => v === sb[i]);
  }
  return jsonEqual(na, nb);
}

function jsonEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || b === null || typeof a !== typeof b) return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((v, i) => jsonEqual(v, b[i]));
  }
  if (typeof a === "object" && typeof b === "object") {
    const ka = Object.keys(a as Record<string, unknown>).sort();
    const kb = Object.keys(b as Record<string, unknown>).sort();
    if (ka.length !== kb.length || ka.some((k, i) => k !== kb[i])) return false;
    return ka.every((k) =>
      jsonEqual((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]),
    );
  }
  return false;
}
