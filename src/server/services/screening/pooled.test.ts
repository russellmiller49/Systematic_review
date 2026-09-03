import { describe, expect, it } from "vitest";
import { groupPooledCitationRows } from "./pooled";

function row(
  id: string,
  overrides: Partial<{
    projectId: string;
    doi: string | null;
    pmid: string | null;
    normalizedTitle: string;
    createdAt: Date;
  }> = {},
) {
  return {
    id,
    projectId: overrides.projectId ?? `project-${id}`,
    doi: overrides.doi ?? null,
    pmid: overrides.pmid ?? null,
    normalizedTitle: overrides.normalizedTitle ?? `title ${id}`,
    createdAt: overrides.createdAt ?? new Date(`2026-01-${id.padStart(2, "0")}T00:00:00Z`),
  };
}

describe("groupPooledCitationRows", () => {
  it("builds transitive cross-PICO groups from DOI, PMID, and exact normalized title", () => {
    const groups = groupPooledCitationRows([
      row("1", { doi: "10.1000/ABC", normalizedTitle: "first title" }),
      row("2", { doi: "10.1000/abc", normalizedTitle: "bridge title" }),
      row("3", { normalizedTitle: "bridge title" }),
      row("4", { pmid: "12345", normalizedTitle: "different" }),
      row("5", { pmid: "12345", normalizedTitle: "another" }),
      row("6"),
    ]);

    expect(groups.map((group) => group.map((citation) => citation.id))).toEqual([
      ["1", "2", "3"],
      ["4", "5"],
      ["6"],
    ]);
  });

  it("does not merge rows whose available exact identities differ", () => {
    const groups = groupPooledCitationRows([
      row("1", { doi: "10.1/one", normalizedTitle: "one" }),
      row("2", { doi: "10.1/two", normalizedTitle: "two" }),
      row("3", { normalizedTitle: "" }),
      row("4", { normalizedTitle: "" }),
    ]);

    expect(groups).toHaveLength(4);
  });
});
