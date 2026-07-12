import { describe, expect, it } from "vitest";
import {
  buildPrismaDiagramLayout,
  escapeXml,
  prismaDiagramSvg,
  wrapText,
  type DiagramCountRow,
} from "./diagram-layout";

/** Count lines use non-breaking spaces inside "(n = X)" — normalize for assertions. */
function norm(text: string): string {
  return text.replace(/\u00A0/g, " ");
}

function allTexts(layout: ReturnType<typeof buildPrismaDiagramLayout>): string[] {
  return layout.boxes.flatMap((b) => b.lines.map((l) => norm(l.text)));
}

const FULL_COUNTS: DiagramCountRow[] = [
  { key: "records_identified", value: 20, breakdown: { PubMed: 12, Embase: 8 } },
  { key: "duplicates_removed", value: 3 },
  { key: "records_screened", value: 17 },
  { key: "records_excluded_ta", value: 9 },
  { key: "reports_sought", value: 8 },
  { key: "reports_not_retrieved", value: 1 },
  { key: "reports_assessed", value: 7 },
  { key: "reports_excluded", value: 4, breakdown: { "Wrong population": 3, "Wrong design": 1 } },
  { key: "studies_included", value: 3 },
  { key: "reports_included", value: 3 },
  { key: "studies_in_quantitative_synthesis", value: 2 },
];

describe("wrapText", () => {
  it("keeps short text on one line", () => {
    expect(wrapText("Records screened", 40)).toEqual(["Records screened"]);
  });

  it("wraps at word boundaries within the budget", () => {
    const lines = wrapText("Reports assessed for eligibility in the review", 20);
    expect(lines.length).toBeGreaterThan(1);
    for (const line of lines) expect(line.length).toBeLessThanOrEqual(20);
    expect(lines.join(" ")).toBe("Reports assessed for eligibility in the review");
  });

  it("hard-breaks words longer than the budget", () => {
    const lines = wrapText("Supercalifragilistic", 10);
    expect(lines).toEqual(["Supercalif", "ragilistic"]);
  });

  it("returns a single empty line for empty text", () => {
    expect(wrapText("", 10)).toEqual([""]);
  });
});

describe("escapeXml", () => {
  it("escapes all XML-special characters", () => {
    expect(escapeXml(`<b>&"'`)).toBe("&lt;b&gt;&amp;&quot;&#39;");
  });
});

describe("buildPrismaDiagramLayout", () => {
  it("lays out 9 boxes, 8 arrows and 3 stage bars for a full report", () => {
    const layout = buildPrismaDiagramLayout(FULL_COUNTS);
    expect(layout.boxes).toHaveLength(9); // 5 main + 4 exclusion boxes
    expect(layout.arrows).toHaveLength(8); // 4 down + 4 right
    expect(layout.bars.map((b) => b.label)).toEqual(["Identification", "Screening", "Included"]);
  });

  it("aligns the main column and stacks rows downward", () => {
    const layout = buildPrismaDiagramLayout(FULL_COUNTS);
    const mainBoxes = layout.boxes.filter((b) => b.x === layout.boxes[0]?.x);
    expect(mainBoxes).toHaveLength(5);
    for (let i = 1; i < mainBoxes.length; i++) {
      const box = mainBoxes[i]!;
      const previous = mainBoxes[i - 1]!;
      expect(box.y).toBeGreaterThan(previous.y + previous.height);
    }
    const maxBottom = Math.max(...layout.boxes.map((b) => b.y + b.height));
    expect(layout.height).toBeGreaterThan(maxBottom);
  });

  it("renders per-source and per-reason breakdown lines sorted by count", () => {
    const layout = buildPrismaDiagramLayout(FULL_COUNTS);
    const texts = allTexts(layout);
    const pubmed = texts.indexOf("PubMed (n = 12)");
    const embase = texts.indexOf("Embase (n = 8)");
    expect(pubmed).toBeGreaterThan(-1);
    expect(embase).toBeGreaterThan(pubmed);
    expect(texts).toContain("Wrong population (n = 3)");
    // Longer than one line — wraps, so assert on the rejoined text.
    expect(texts.join(" ")).toContain("Studies in quantitative synthesis (n = 2)");
  });

  it("renders the full template with zeros when counts are missing", () => {
    const layout = buildPrismaDiagramLayout([]);
    const texts = allTexts(layout);
    expect(layout.boxes).toHaveLength(9);
    expect(texts).toContain("Databases (n = 0)");
    expect(texts).toContain("Records screened (n = 0)");
    expect(texts).toContain("Reports excluded (n = 0)");
    // The quantitative-synthesis line only appears when the count is reported.
    expect(texts.some((t) => t.startsWith("Studies in quantitative synthesis"))).toBe(false);
  });

  it("collapses the exclusion-reason box to a single line without a breakdown", () => {
    const layout = buildPrismaDiagramLayout([{ key: "reports_excluded", value: 4 }]);
    const texts = allTexts(layout);
    expect(texts).toContain("Reports excluded (n = 4)");
    expect(texts).not.toContain("Reports excluded:");
  });

  it("formats large counts with thousands separators", () => {
    const layout = buildPrismaDiagramLayout([{ key: "records_screened", value: 12345 }]);
    const texts = allTexts(layout);
    expect(texts).toContain("Records screened (n = 12,345)");
  });
});

describe("prismaDiagramSvg", () => {
  it("produces a standalone SVG with the expected content", () => {
    const svg = norm(prismaDiagramSvg(buildPrismaDiagramLayout(FULL_COUNTS)));
    expect(svg.startsWith(`<svg xmlns="http://www.w3.org/2000/svg"`)).toBe(true);
    expect(svg).toContain("PRISMA 2020 flow diagram");
    expect(svg).toContain("Records screened (n = 17)");
    expect(svg).toContain(`marker id="pf-arrow"`);
    expect(svg.endsWith("</svg>")).toBe(true);
  });

  it("escapes user-provided labels (source names, exclusion reasons)", () => {
    const svg = prismaDiagramSvg(
      buildPrismaDiagramLayout([
        {
          key: "reports_excluded",
          value: 1,
          breakdown: { '<script>alert("x")</script> & more': 1 },
        },
      ]),
    );
    expect(svg).not.toContain("<script>");
    expect(svg).toContain("&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt; &amp; more");
  });
});
