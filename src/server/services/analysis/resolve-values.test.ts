import { describe, expect, it } from "vitest";
import {
  expandTemplateLineage,
  resolveNumericField,
  type ResolveNumericInput,
} from "./resolve-values";

// Convenience: build an input with sensible defaults.
function input(overrides: Partial<ResolveNumericInput> = {}): ResolveNumericInput {
  return { completed: [], inProgress: [], includeProvisional: false, ...overrides };
}

const vals = (...values: unknown[]) => values.map((value) => ({ value }));

describe("resolveNumericField", () => {
  // --- adjudication tier ---------------------------------------------------

  it("prefers a RESOLVED conflict's adjudicated value over everything else", () => {
    const r = resolveNumericField(
      input({
        completed: vals(10, 20),
        inProgress: vals(99),
        conflictStatus: "RESOLVED",
        adjudicatedValue: 15,
        includeProvisional: true,
      }),
    );
    expect(r).toEqual({ value: 15, source: "ADJUDICATED", disputed: false });
  });

  it("treats a non-numeric adjudicated value as missing, not disputed", () => {
    const r = resolveNumericField(
      input({ completed: vals(10), conflictStatus: "RESOLVED", adjudicatedValue: "12" }),
    );
    expect(r).toEqual({ value: null, source: null, disputed: false });
  });

  it("treats a null adjudicated value as missing", () => {
    const r = resolveNumericField(
      input({ conflictStatus: "RESOLVED", adjudicatedValue: null }),
    );
    expect(r).toEqual({ value: null, source: null, disputed: false });
  });

  it("falls through a RESOLVED conflict with no adjudicated value to completed forms", () => {
    const r = resolveNumericField(
      input({ completed: vals(7), conflictStatus: "RESOLVED", adjudicatedValue: undefined }),
    );
    expect(r).toEqual({ value: 7, source: "SINGLE", disputed: false });
  });

  it("accepts an adjudicated value of 0", () => {
    const r = resolveNumericField(
      input({ conflictStatus: "RESOLVED", adjudicatedValue: 0 }),
    );
    expect(r).toEqual({ value: 0, source: "ADJUDICATED", disputed: false });
  });

  // --- open conflicts --------------------------------------------------------

  it("marks an OPEN conflict as disputed even when completed forms agree", () => {
    const r = resolveNumericField(input({ completed: vals(5, 5), conflictStatus: "OPEN" }));
    expect(r).toEqual({ value: null, source: null, disputed: true });
  });

  it("ignores VOIDED conflicts", () => {
    const r = resolveNumericField(input({ completed: vals(5, 5), conflictStatus: "VOIDED" }));
    expect(r).toEqual({ value: 5, source: "CONSENSUS", disputed: false });
  });

  // --- completed tiers -------------------------------------------------------

  it("resolves >=2 equal completed values as CONSENSUS", () => {
    const r = resolveNumericField(input({ completed: vals(12, 12, 12) }));
    expect(r).toEqual({ value: 12, source: "CONSENSUS", disputed: false });
  });

  it("resolves exactly 1 completed value as SINGLE", () => {
    const r = resolveNumericField(input({ completed: vals(3.5) }));
    expect(r).toEqual({ value: 3.5, source: "SINGLE", disputed: false });
  });

  it("marks >=2 differing completed values as disputed (conflict row may lag)", () => {
    const r = resolveNumericField(input({ completed: vals(10, 11) }));
    expect(r).toEqual({ value: null, source: null, disputed: true });
  });

  it("prefers completed values over in-progress values even with includeProvisional", () => {
    const r = resolveNumericField(
      input({ completed: vals(8), inProgress: vals(99, 100), includeProvisional: true }),
    );
    expect(r).toEqual({ value: 8, source: "SINGLE", disputed: false });
  });

  it("treats a non-numeric SINGLE value as missing", () => {
    const r = resolveNumericField(input({ completed: vals("twelve") }));
    expect(r).toEqual({ value: null, source: null, disputed: false });
  });

  it("treats a non-finite CONSENSUS value as missing", () => {
    const r = resolveNumericField(input({ completed: vals(Infinity, Infinity) }));
    expect(r).toEqual({ value: null, source: null, disputed: false });
  });

  it("treats agreeing null completed values as missing, not disputed", () => {
    const r = resolveNumericField(input({ completed: vals(null, null) }));
    expect(r).toEqual({ value: null, source: null, disputed: false });
  });

  it("treats a null vs number disagreement as disputed", () => {
    const r = resolveNumericField(input({ completed: vals(5, null) }));
    expect(r).toEqual({ value: null, source: null, disputed: true });
  });

  // --- provisional tier ------------------------------------------------------

  it("resolves a single in-progress value as PROVISIONAL when opted in", () => {
    const r = resolveNumericField(input({ inProgress: vals(42), includeProvisional: true }));
    expect(r).toEqual({ value: 42, source: "PROVISIONAL", disputed: false });
  });

  it("resolves multiple equal in-progress values as PROVISIONAL", () => {
    const r = resolveNumericField(
      input({ inProgress: vals(42, 42), includeProvisional: true }),
    );
    expect(r).toEqual({ value: 42, source: "PROVISIONAL", disputed: false });
  });

  it("marks differing in-progress values as disputed when opted in", () => {
    const r = resolveNumericField(
      input({ inProgress: vals(42, 43), includeProvisional: true }),
    );
    expect(r).toEqual({ value: null, source: null, disputed: true });
  });

  it("ignores in-progress values entirely when includeProvisional is false", () => {
    const r = resolveNumericField(input({ inProgress: vals(42, 43) }));
    expect(r).toEqual({ value: null, source: null, disputed: false });
  });

  it("treats a non-numeric PROVISIONAL value as missing", () => {
    const r = resolveNumericField(input({ inProgress: vals(true), includeProvisional: true }));
    expect(r).toEqual({ value: null, source: null, disputed: false });
  });

  // --- empty -----------------------------------------------------------------

  it("returns missing when there is no data at all", () => {
    const r = resolveNumericField(input());
    expect(r).toEqual({ value: null, source: null, disputed: false });
  });

  it("returns missing when there is no conflict and no completed forms (no opt-in)", () => {
    const r = resolveNumericField(input({ inProgress: vals(1), conflictStatus: null }));
    expect(r).toEqual({ value: null, source: null, disputed: false });
  });
});

describe("expandTemplateLineage", () => {
  const t = (id: string, sourceTemplateId: string | null = null) => ({ id, sourceTemplateId });

  it("returns just the template itself when it has no lineage", () => {
    expect(expandTemplateLineage([t("a"), t("x")], "a")).toEqual(new Set(["a"]));
  });

  it("includes the template id even when it is missing from the list", () => {
    expect(expandTemplateLineage([t("x")], "ghost")).toEqual(new Set(["ghost"]));
  });

  it("expands a middle version to the full chain (ancestors and descendants)", () => {
    const templates = [t("v1"), t("v2", "v1"), t("v3", "v2")];
    expect(expandTemplateLineage(templates, "v2")).toEqual(new Set(["v1", "v2", "v3"]));
  });

  it("expands a leaf up to the root and back down through every branch", () => {
    const templates = [t("root"), t("a", "root"), t("b", "root"), t("a2", "a")];
    expect(expandTemplateLineage(templates, "a2")).toEqual(
      new Set(["root", "a", "b", "a2"]),
    );
  });

  it("expands the root to all descendants", () => {
    const templates = [t("root"), t("a", "root"), t("b", "a")];
    expect(expandTemplateLineage(templates, "root")).toEqual(new Set(["root", "a", "b"]));
  });

  it("excludes unrelated lineages", () => {
    const templates = [t("v1"), t("v2", "v1"), t("other1"), t("other2", "other1")];
    expect(expandTemplateLineage(templates, "v2")).toEqual(new Set(["v1", "v2"]));
  });

  it("terminates on cyclic lineage data", () => {
    const templates = [t("a", "b"), t("b", "a")];
    expect(expandTemplateLineage(templates, "a")).toEqual(new Set(["a", "b"]));
  });
});
