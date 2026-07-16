// Unit tests for the pure funnel-plot layout + SVG renderer.
// Run: npx vitest run src/components/analysis/funnel-plot-layout.test.ts

import { describe, expect, it } from "vitest";
import { ftInverse, invLogit } from "@/lib/stats/effects/proportion";
import {
  buildFunnelPlotLayout,
  funnelPlotSvg,
  funnelTickValues,
  type FunnelPlotInput,
} from "./funnel-plot-layout";

function input(overrides: Partial<FunnelPlotInput> = {}): FunnelPlotInput {
  return {
    title: "Mortality at 30 days",
    measureLabel: "Risk ratio (RR)",
    scale: "log",
    harmonicN: null,
    points: [
      { label: "Study A", y: -0.6, se: 0.15 },
      { label: "Study B", y: -0.4, se: 0.25 },
      { label: "Study C", y: -0.9, se: 0.4 },
    ],
    pooledY: -0.6,
    egger: { intercept: 1.23, interceptSe: 0.4, t: 3.1, p: 0.045, k: 3 },
    ...overrides,
  };
}

describe("geometry", () => {
  it("inverts the se axis: smaller standard errors sit higher", () => {
    const layout = buildFunnelPlotLayout(input());
    const [a, , c] = layout.points;
    expect(a!.cy).toBeLessThan(c!.cy); // se 0.15 above se 0.4
    expect(a!.cy).toBeGreaterThanOrEqual(layout.plot.top);
    expect(c!.cy).toBeLessThanOrEqual(layout.plot.bottom);
  });

  it("anchors the funnel region apex on the pooled line at se = 0", () => {
    const layout = buildFunnelPlotLayout(input());
    expect(layout.region).not.toBeNull();
    expect(layout.pooledLineX).not.toBeNull();
    expect(layout.region!.apex.x).toBe(layout.pooledLineX);
    expect(layout.region!.apex.y).toBe(layout.plot.top);
    expect(layout.region!.left.y).toBe(layout.plot.bottom);
    expect(layout.region!.left.x).toBeLessThan(layout.region!.right.x);
  });

  it("keeps every point inside the plot band", () => {
    const layout = buildFunnelPlotLayout(input());
    for (const p of layout.points) {
      expect(p.cx).toBeGreaterThanOrEqual(layout.plot.left);
      expect(p.cx).toBeLessThanOrEqual(layout.plot.right);
    }
  });

  it("omits region and pooled line without a pooled estimate", () => {
    const layout = buildFunnelPlotLayout(input({ pooledY: null }));
    expect(layout.region).toBeNull();
    expect(layout.pooledLineX).toBeNull();
  });

  it("drops non-finite points instead of breaking the layout", () => {
    const layout = buildFunnelPlotLayout(
      input({
        points: [
          { label: "ok", y: -0.5, se: 0.2 },
          { label: "bad", y: NaN, se: 0.2 },
          { label: "ok2", y: -0.3, se: 0.31 },
        ],
      }),
    );
    expect(layout.points).toHaveLength(2);
  });
});

describe("axis ticks (display-labeled analysis scale)", () => {
  it("log scale positions ticks at ln(display) with display labels", () => {
    const ticks = funnelTickValues("log", Math.log(0.3), Math.log(3), null);
    const byLabel = Object.fromEntries(ticks.map((t) => [t.label, t.position]));
    expect(byLabel["1"]).toBeCloseTo(0, 12);
    expect(byLabel["0.5"]).toBeCloseTo(Math.log(0.5), 12);
    expect(byLabel["2"]).toBeCloseTo(Math.log(2), 12);
  });

  it("logit scale labels ticks with proportions at logit positions", () => {
    const ticks = funnelTickValues("logit", Math.log(0.1 / 0.9), Math.log(0.9 / 0.1), null);
    const byLabel = Object.fromEntries(ticks.map((t) => [t.label, t.position]));
    expect(byLabel["0.5"]).toBeCloseTo(0, 12);
    expect(byLabel["0.2"]).toBeCloseTo(Math.log(0.2 / 0.8), 12);
    // Round-trip: label = invLogit(position) for every tick.
    for (const t of ticks) {
      expect(invLogit(t.position)).toBeCloseTo(Number(t.label), 10);
    }
  });

  it("ft scale places proportion labels via the harmonic-n inverse (round-trip)", () => {
    const n = 50.139;
    const ticks = funnelTickValues("ft", 0.2, 1.2, n);
    expect(ticks.length).toBeGreaterThanOrEqual(2);
    for (const t of ticks) {
      expect(ftInverse(t.position, n)).toBeCloseTo(Number(t.label), 6);
    }
  });

  it("linear scale uses plain nice ticks", () => {
    const ticks = funnelTickValues("linear", 0, 10, null);
    expect(ticks.map((t) => t.label)).toEqual(["0", "2", "4", "6", "8", "10"]);
  });
});

describe("footers", () => {
  it("formats the Egger line and adds the low-power caveat when k < 10", () => {
    const layout = buildFunnelPlotLayout(input());
    expect(layout.footers[0]?.text).toBe("Egger's test: intercept 1.23 (p = 0.045)");
    expect(layout.footers[1]?.text).toBe("k = 3 < 10 — low power to detect asymmetry");
  });

  it("floors tiny p-values and skips the caveat at k >= 10", () => {
    const layout = buildFunnelPlotLayout(
      input({ egger: { intercept: -0.51, interceptSe: 0.1, t: -5.1, p: 0.0002, k: 12 } }),
    );
    expect(layout.footers[0]?.text).toBe("Egger's test: intercept -0.51 (p < 0.001)");
    expect(layout.footers).toHaveLength(1);
  });

  it("explains the k >= 3 requirement when Egger is null with fewer than 3 points", () => {
    const layout = buildFunnelPlotLayout(
      input({
        egger: null,
        points: [
          { label: "Study A", y: -0.6, se: 0.15 },
          { label: "Study B", y: -0.4, se: 0.25 },
        ],
      }),
    );
    expect(layout.footers[0]?.text).toBe("Egger's test requires at least 3 pooled studies");
  });

  it("reports a degenerate fit (not k < 3) when Egger is null with 3+ points", () => {
    // eggerTest returns null for identical precisions at any k — the footer must not
    // claim "requires at least 3 pooled studies" while 3+ points are on the plot.
    const layout = buildFunnelPlotLayout(input({ egger: null }));
    expect(layout.footers[0]?.text).toBe(
      "Egger's test not estimable (studies have identical precision)",
    );
  });
});

describe("empty state + SVG rendering", () => {
  it("renders a placeholder when there are no points", () => {
    const layout = buildFunnelPlotLayout(input({ points: [], pooledY: null }));
    expect(layout.placeholder?.text).toBe("No studies pooled yet");
    const svg = funnelPlotSvg(layout);
    expect(svg).toMatch(/^<svg[^>]*xmlns="http:\/\/www\.w3\.org\/2000\/svg"/);
    expect(svg.endsWith("</svg>")).toBe(true);
    expect(svg).toContain("No studies pooled yet");
  });

  it("escapes hostile study labels and titles everywhere", () => {
    const hostile = `<script>alert("x")</script> & 'more'`;
    const layout = buildFunnelPlotLayout(
      input({ title: `Title ${hostile}`, points: [{ label: hostile, y: -0.2, se: 0.2 }] }),
    );
    const svg = funnelPlotSvg(layout);
    expect(svg).not.toContain("<script>");
    expect(svg).toContain("&lt;script&gt;");
    expect(svg).toContain("&amp;");
  });

  it("renders points with tooltips, region, pooled line, and axis captions", () => {
    const svg = funnelPlotSvg(buildFunnelPlotLayout(input()));
    expect(svg).toContain("<circle");
    expect(svg).toContain("<title>Study A</title>");
    expect(svg).toContain("<polygon");
    expect(svg).toContain("Standard error");
    expect(svg).toContain("Risk ratio (RR)");
    expect(svg).toContain("Egger&#39;s test");
  });
});
