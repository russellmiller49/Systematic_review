import { describe, expect, it } from "vitest";
import { resolveMatrixCell, type MatrixEntry } from "./matrix-resolve";

function entry(overrides: Partial<MatrixEntry> & { value: unknown }): MatrixEntry {
  return {
    formId: "f1",
    extractor: { id: "u1", name: "One" },
    formStatus: "COMPLETED",
    sourceQuote: null,
    pageNumber: null,
    sourceAnchor: null,
    updatedAt: new Date(0),
    ...overrides,
  };
}

describe("resolveMatrixCell", () => {
  it("prefers the adjudicated value over everything else", () => {
    const cell = resolveMatrixCell({
      fieldType: "NUMBER",
      entries: [entry({ value: 10 }), entry({ value: 20, formId: "f2" })],
      conflictStatus: "RESOLVED",
      adjudicatedValue: 15,
    });
    expect(cell).toEqual({ resolved: { value: 15, source: "ADJUDICATED" }, disputed: false });
  });

  it("marks an OPEN conflict as disputed with no resolved value", () => {
    const cell = resolveMatrixCell({
      fieldType: "NUMBER",
      entries: [entry({ value: 10 }), entry({ value: 20, formId: "f2" })],
      conflictStatus: "OPEN",
    });
    expect(cell).toEqual({ resolved: null, disputed: true });
  });

  it("ignores VOIDED conflicts and resolves agreement across completed forms", () => {
    const cell = resolveMatrixCell({
      fieldType: "NUMBER",
      entries: [entry({ value: 10 }), entry({ value: 10, formId: "f2" })],
      conflictStatus: "VOIDED",
    });
    expect(cell).toEqual({ resolved: { value: 10, source: "AGREED" }, disputed: false });
  });

  it("resolves a single completed form as SINGLE, ignoring in-progress entries", () => {
    const cell = resolveMatrixCell({
      fieldType: "TEXT",
      entries: [
        entry({ value: "final", formStatus: "COMPLETED" }),
        entry({ value: "draft", formStatus: "IN_PROGRESS", formId: "f2" }),
      ],
    });
    expect(cell).toEqual({ resolved: { value: "final", source: "SINGLE" }, disputed: false });
  });

  it("treats disagreeing completed forms without a conflict row as disputed", () => {
    const cell = resolveMatrixCell({
      fieldType: "TEXT",
      entries: [entry({ value: "a" }), entry({ value: "b", formId: "f2" })],
    });
    expect(cell).toEqual({ resolved: null, disputed: true });
  });

  it("uses type-aware equality (MULTI_SELECT order-insensitive)", () => {
    const cell = resolveMatrixCell({
      fieldType: "MULTI_SELECT",
      entries: [entry({ value: ["a", "b"] }), entry({ value: ["b", "a"], formId: "f2" })],
    });
    expect(cell.resolved?.source).toBe("AGREED");
  });

  it("returns an empty cell when nothing is completed", () => {
    const cell = resolveMatrixCell({
      fieldType: "TEXT",
      entries: [entry({ value: "draft", formStatus: "IN_PROGRESS" })],
    });
    expect(cell).toEqual({ resolved: null, disputed: false });
  });
});
