import { describe, expect, it } from "vitest";
import { projectCompanionGraph } from "./companions";
const active = (id: string) => ({ id, status: "ACTIVE", duplicateOfId: null });
const edge = (a: string, b: string) => ({
  id: `${a}-${b}`,
  citationAId: a,
  citationBId: b,
});
describe("confirmed companion graph projection", () => {
  it("follows multiple canonical replacements without changing the historical pair", () => {
    const graph = projectCompanionGraph(
      [
        active("a"),
        active("b"),
        { id: "copy", status: "DUPLICATE", duplicateOfId: "old" },
        { id: "old", status: "DUPLICATE", duplicateOfId: "a" },
      ],
      [edge("copy", "b")],
    );
    expect(graph.sameStudy("a", "b")).toBe(true);
    expect(graph.edges[0]).toMatchObject({
      citationAId: "copy",
      a: "a",
      b: "b",
    });
    expect(graph.hasDirectConflict(["a", "b"])).toBe(true);
    expect(graph.hasDirectConflict(["copy", "b"])).toBe(true);
    expect(graph.hasDirectConflict(["copy", "a"])).toBe(false);
    expect(graph.hasDirectConflict(["a", "unrelated"])).toBe(false);
  });
  it("recognizes transitive companions and rejects corrupt alias cycles", () => {
    const graph = projectCompanionGraph(
      [
        active("a"),
        active("b"),
        active("c"),
        { id: "cycle", status: "DUPLICATE", duplicateOfId: "cycle" },
      ],
      [edge("a", "b"), edge("b", "c"), edge("cycle", "a")],
    );
    expect(graph.sameStudy("a", "c")).toBe(true);
    expect(graph.hasDirectConflict(["a", "c"])).toBe(false);
    expect(graph.hasDirectConflict(["a", "b", "c"])).toBe(true);
    expect([...graph.members("a")].sort()).toEqual(["a", "b", "c"]);
    expect(graph.root("cycle")).toBeNull();
    expect(graph.root("foreign")).toBeNull();
  });
});
