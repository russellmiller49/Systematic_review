import { describe, expect, it } from "vitest";
import { isLockStale, LOCK_STALE_MS } from "./lock-rules";
import { collectCitationRefs, countWords, extractDocText, validateDoc } from "./doc-text";
import { formatCiteMarker } from "./cite-format";
import { docToBlocks, offsetNumberingGroups } from "./docx-map";

const DOC = {
  type: "doc",
  content: [
    { type: "heading", attrs: { level: 2 }, content: [{ type: "text", text: "Background" }] },
    {
      type: "paragraph",
      content: [
        { type: "text", text: "Valves " },
        { type: "text", text: "work", marks: [{ type: "bold" }, { type: "italic" }] },
        { type: "hardBreak" },
        { type: "text", text: "sometimes" },
        { type: "citation", attrs: { referenceIds: ["r2", "r1"] } },
      ],
    },
    {
      type: "bulletList",
      content: [
        {
          type: "listItem",
          content: [{ type: "paragraph", content: [{ type: "text", text: "First point" }] }],
        },
        {
          type: "listItem",
          content: [
            { type: "paragraph", content: [{ type: "text", text: "Second point" }] },
            {
              type: "orderedList",
              content: [
                {
                  type: "listItem",
                  content: [
                    { type: "paragraph", content: [{ type: "text", text: "Nested numbered" }] },
                  ],
                },
              ],
            },
          ],
        },
      ],
    },
    {
      type: "blockquote",
      content: [{ type: "paragraph", content: [{ type: "text", text: "Quoted line" }] }],
    },
    { type: "horizontalRule" },
    {
      type: "orderedList",
      content: [
        {
          type: "listItem",
          content: [{ type: "paragraph", content: [{ type: "text", text: "Top numbered" }] }],
        },
      ],
    },
  ],
};

describe("lock-rules", () => {
  const now = new Date("2026-07-21T12:00:00Z");
  it("stale exactly at the boundary and for missing heartbeats", () => {
    expect(isLockStale(null, now)).toBe(true);
    expect(isLockStale(new Date(now.getTime() - LOCK_STALE_MS + 1), now)).toBe(false);
    expect(isLockStale(new Date(now.getTime() - LOCK_STALE_MS), now)).toBe(true);
  });
});

describe("doc-text", () => {
  it("extracts block text with hardBreak newlines and citation fallbacks", () => {
    const text = extractDocText(DOC);
    expect(text).toContain("Background");
    expect(text).toContain("Valves work\nsometimes[citation]");
    expect(text).toContain("First point");
    expect(text).toContain("Quoted line");
  });

  it("counts words across unicode whitespace; empty doc is 0", () => {
    expect(countWords("one  two\nthree four")).toBe(4);
    expect(countWords(extractDocText({ type: "doc", content: [] }))).toBe(0);
  });

  it("collects citation referenceIds in document order, deduped", () => {
    const secondDoc = {
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [
            { type: "citation", attrs: { referenceIds: ["r3"] } },
            { type: "citation", attrs: { referenceIds: ["r1"] } },
          ],
        },
      ],
    };
    expect(collectCitationRefs([DOC, secondDoc])).toEqual(["r2", "r1", "r3"]);
  });

  it("validates doc shape and size", () => {
    expect(validateDoc(DOC).ok).toBe(true);
    expect(validateDoc(null).ok).toBe(false);
    expect(validateDoc({ type: "paragraph" }).ok).toBe(false);
    expect(validateDoc([1, 2]).ok).toBe(false);
  });
});

describe("cite-format", () => {
  const citeMap = { numeric: true, markers: { r1: "1", r2: "2" } };
  it("groups numeric markers, falls back to [?]", () => {
    expect(formatCiteMarker(["r1", "r2"], citeMap)).toBe("[1, 2]");
    expect(formatCiteMarker(["r1", "missing"], citeMap)).toBe("[1, ?]");
    expect(formatCiteMarker(["r1"], null)).toBe("[?]");
    expect(formatCiteMarker([], citeMap)).toBe("[?]");
  });
  it("author-year style joins with semicolons in parens", () => {
    expect(
      formatCiteMarker(["r1"], { numeric: false, markers: { r1: "Smith & Jones, 2020" } }),
    ).toBe("(Smith & Jones, 2020)");
  });
});

describe("docx-map", () => {
  const blocks = docToBlocks(DOC, (ids) => `[${ids.length}]`);

  it("maps headings, marks, hardBreaks, and citations", () => {
    expect(blocks[0]).toMatchObject({ kind: "heading2" });
    const para = blocks[1]!;
    expect(para.kind).toBe("paragraph");
    expect(para.runs[1]).toMatchObject({ text: "work", bold: true, italics: true });
    expect(para.runs[2]).toMatchObject({ text: "sometimes", break: true });
    expect(para.runs[3]!.text).toBe("[2]");
  });

  it("maps lists with levels and per-instance numbering groups", () => {
    const bullets = blocks.filter((b) => b.kind === "bullet");
    expect(bullets.map((b) => b.runs[0]!.text)).toEqual(["First point", "Second point"]);
    expect(bullets.every((b) => b.level === 0)).toBe(true);

    const numbered = blocks.filter((b) => b.kind === "numbered");
    expect(numbered).toHaveLength(2);
    const nested = numbered.find((b) => b.runs[0]!.text === "Nested numbered")!;
    const top = numbered.find((b) => b.runs[0]!.text === "Top numbered")!;
    expect(nested.level).toBe(1);
    expect(top.level).toBe(0);
    expect(nested.numberingGroup).not.toBe(top.numberingGroup); // numbering restarts
  });

  it("maps blockquote and horizontal rule; unknown docs yield nothing", () => {
    expect(blocks.some((b) => b.kind === "blockquote" && b.runs[0]!.text === "Quoted line")).toBe(true);
    expect(blocks.some((b) => b.kind === "hr")).toBe(true);
    expect(docToBlocks({ type: "nope" }, () => "")).toEqual([]);
  });

  it("offsets numbering groups so lists from different sections never share a group", () => {
    const numbered = (group: number) => ({
      kind: "numbered" as const,
      runs: [{ text: "item" }],
      numberingGroup: group,
    });
    const plain = { kind: "paragraph" as const, runs: [{ text: "prose" }] };
    // Two sections whose docToBlocks calls each restarted their counter at 1.
    const [a, b, c] = offsetNumberingGroups([
      [numbered(1), plain, numbered(2)],
      [numbered(1)],
      [plain],
    ]);
    expect(a!.map((blk) => blk.numberingGroup)).toEqual([1, undefined, 2]);
    expect(b![0]!.numberingGroup).toBe(3); // shifted past section A's max group
    expect(c![0]!.numberingGroup).toBeUndefined();
  });
});
