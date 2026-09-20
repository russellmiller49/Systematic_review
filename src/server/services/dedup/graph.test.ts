import { describe, expect, it } from "vitest";
import { connectedComponents } from "./graph";

const edge = (citationAId: string, citationBId: string) => ({
  citationAId,
  citationBId,
});
describe("connectedComponents", () => {
  it("handles empty graphs, chains, cycles, and bridge removal", () => {
    expect(connectedComponents([])).toEqual([]);
    const a = edge("a1", "a2"),
      b = edge("b1", "b2"),
      bridge = edge("a2", "b1");
    expect(connectedComponents([a, b, bridge])).toHaveLength(1);
    expect(connectedComponents([a, b])).toEqual([[a], [b]]);
    expect(connectedComponents([edge("a", "b"), edge("b", "c"), edge("a", "c")])).toHaveLength(1);
  });
  it("handles long chains without recursive stack growth", () => {
    const edges = Array.from({ length: 20_000 }, (_, i) => edge(String(i), String(i + 1)));
    expect(connectedComponents(edges)).toEqual([edges]);
  });
});
