// Unit tests for the pure forest-plot layout + SVG renderer.
// Run: npx vitest run src/components/analysis/forest-plot-layout.test.ts

import { describe, expect, it } from "vitest";
import {
  buildForestPlotLayout,
  forestPlotSvg,
  linearTicks,
  logTicks,
  type ForestPlotInput,
  type ForestPlotRow,
} from "./forest-plot-layout";

function row(overrides: Partial<ForestPlotRow> = {}): ForestPlotRow {
  return {
    label: "Study A",
    estimate: 0.5,
    ciLow: 0.3,
    ciHigh: 0.8,
    weightPct: 25,
    dataCols: ["10/50", "20/50"],
    ...overrides,
  };
}

function input(overrides: Partial<ForestPlotInput> = {}): ForestPlotInput {
  return {
    title: "Mortality at 30 days",
    measureLabel: "OR",
    scale: "log",
    nullValue: 1,
    columnHeaders: ["Intervention", "Control"],
    rows: [row()],
    pooled: null,
    heterogeneity: null,
    excluded: [],
    ...overrides,
  };
}

describe("tick generation", () => {
  it("log scale picks pretty 1/2/5 ticks inside the window", () => {
    expect(logTicks(0.15, 6)).toEqual([0.2, 0.5, 1, 2, 5]);
    expect(logTicks(0.01, 100)).toEqual([
      0.01, 0.02, 0.05, 0.1, 0.2, 0.5, 1, 2, 5, 10, 20, 50, 100,
    ]);
  });

  it("log scale falls back to the endpoints when fewer than two pretty ticks fit", () => {
    const ticks = logTicks(1.3, 1.7);
    expect(ticks).toHaveLength(2);
    expect(ticks[0]).toBeCloseTo(1.3, 5);
    expect(ticks[1]).toBeCloseTo(1.7, 5);
  });

  it("linear scale produces nice evenly stepped ticks covering the window", () => {
    expect(linearTicks(0, 10)).toEqual([0, 2, 4, 6, 8, 10]);
    const ticks = linearTicks(-4.3, 3.1);
    expect(ticks).toEqual([-4, -2, 0, 2]);
    for (const t of ticks) {
      expect(t).toBeGreaterThanOrEqual(-4.3);
      expect(t).toBeLessThanOrEqual(3.1);
    }
  });

  it("layout axis ticks are strictly increasing in x", () => {
    const layout = buildForestPlotLayout(
      input({ scale: "linear", nullValue: 0, rows: [row({ estimate: -2, ciLow: -5, ciHigh: 1 })] }),
    );
    const xs = (layout.axis?.ticks ?? []).map((t) => t.x);
    expect(xs.length).toBeGreaterThanOrEqual(2);
    for (let i = 1; i < xs.length; i++) expect(xs[i]).toBeGreaterThan(xs[i - 1] ?? Infinity);
  });
});

describe("arrow clipping", () => {
  it("flags CIs beyond the clamped log window and pins them to the plot edges", () => {
    const layout = buildForestPlotLayout(
      input({
        rows: [
          row({ label: "Tiny", estimate: 0.02, ciLow: 0.001, ciHigh: 0.5 }),
          row({ label: "Huge", estimate: 50, ciLow: 2, ciHigh: 1000 }),
        ],
      }),
    );
    const [tiny, huge] = layout.rows;
    expect(tiny?.ci?.arrowLeft).toBe(true);
    expect(tiny?.ci?.arrowRight).toBe(false);
    expect(tiny?.ci?.x1).toBe(layout.plot.left);
    expect(huge?.ci?.arrowRight).toBe(true);
    expect(huge?.ci?.arrowLeft).toBe(false);
    expect(huge?.ci?.x2).toBe(layout.plot.right);
  });

  it("does not flag CIs inside the padded window", () => {
    const layout = buildForestPlotLayout(input());
    const first = layout.rows[0];
    expect(first?.ci?.arrowLeft).toBe(false);
    expect(first?.ci?.arrowRight).toBe(false);
    expect(first?.ci?.x1).toBeGreaterThan(layout.plot.left);
    expect(first?.ci?.x2).toBeLessThan(layout.plot.right);
  });

  it("treats non-positive CI bounds on a log scale as clipped left", () => {
    const layout = buildForestPlotLayout(
      input({ rows: [row({ estimate: 0.5, ciLow: 0, ciHigh: 0.9 })] }),
    );
    expect(layout.rows[0]?.ci?.arrowLeft).toBe(true);
    expect(layout.rows[0]?.ci?.x1).toBe(layout.plot.left);
  });
});

describe("XML escaping", () => {
  it("escapes hostile study labels everywhere they appear", () => {
    const hostile = `<script>alert("x")</script> & 'more'`;
    const layout = buildForestPlotLayout(
      input({
        title: `Title ${hostile}`,
        rows: [row({ label: hostile })],
        excluded: [{ label: hostile, reason: "no <SD> reported" }],
      }),
    );
    const svg = forestPlotSvg(layout);
    expect(svg).not.toContain("<script>");
    expect(svg).toContain("&lt;script&gt;");
    expect(svg).toContain("&amp;");
    expect(svg).toContain("no &lt;SD&gt; reported");
  });
});

describe("square sizing", () => {
  it("square area grows monotonically with weight", () => {
    const layout = buildForestPlotLayout(
      input({
        rows: [5, 10, 20, 40].map((w) =>
          row({ label: `W${w}`, weightPct: w, estimate: 1, ciLow: 0.5, ciHigh: 2 }),
        ),
      }),
    );
    const halves = layout.rows.map((r) => r.square?.half ?? NaN);
    expect(halves.every((h) => Number.isFinite(h))).toBe(true);
    for (let i = 1; i < halves.length; i++) {
      expect(halves[i]).toBeGreaterThanOrEqual(halves[i - 1] ?? Infinity);
    }
    expect(halves[halves.length - 1]).toBeGreaterThan(halves[0] ?? Infinity);
  });
});

describe("pooled diamond", () => {
  it("has four points centered on the pooled estimate, symmetric vertically", () => {
    const layout = buildForestPlotLayout(
      input({
        rows: [row({ estimate: 0.5 })],
        pooled: { label: "Overall (random effects)", estimate: 0.5, ciLow: 0.3, ciHigh: 0.8 },
      }),
    );
    const diamond = layout.diamond;
    expect(diamond).not.toBeNull();
    if (!diamond) return;
    expect(diamond.points).toHaveLength(4);
    const [left, top, right, bottom] = diamond.points;
    // Top and bottom vertices sit on the estimate; the row square at the same
    // estimate shares its x coordinate, so the diamond is centered on it.
    expect(top.x).toBe(bottom.x);
    expect(top.x).toBe(layout.rows[0]?.square?.cx);
    expect(left.x).toBeLessThan(top.x);
    expect(right.x).toBeGreaterThan(top.x);
    // Symmetric about the row center; left/right vertices on the centerline.
    expect(diamond.centerY - top.y).toBe(bottom.y - diamond.centerY);
    expect(left.y).toBe(diamond.centerY);
    expect(right.y).toBe(diamond.centerY);
  });
});

describe("empty state", () => {
  it("renders a valid svg with a placeholder line when there is nothing to plot", () => {
    const layout = buildForestPlotLayout(input({ rows: [], pooled: null }));
    expect(layout.placeholder?.text).toBe("No studies pooled yet");
    expect(layout.axis).toBeNull();
    const svg = forestPlotSvg(layout);
    expect(svg).toMatch(/^<svg[^>]*xmlns="http:\/\/www\.w3\.org\/2000\/svg"/);
    expect(svg.endsWith("</svg>")).toBe(true);
    expect(svg).toContain("No studies pooled yet");
  });
});

describe("provisional rows", () => {
  it("dashes the square outline and suffixes the label", () => {
    const layout = buildForestPlotLayout(input({ rows: [row({ provisional: true })] }));
    expect(layout.rows[0]?.square?.dashed).toBe(true);
    expect(layout.rows[0]?.cells[0]?.text).toBe("Study A (provisional)");
    expect(forestPlotSvg(layout)).toContain("stroke-dasharray");
  });

  it("keeps regular squares solid", () => {
    const layout = buildForestPlotLayout(input());
    expect(layout.rows[0]?.square?.dashed).toBe(false);
    expect(forestPlotSvg(layout)).not.toContain("stroke-dasharray");
  });
});

describe("footers", () => {
  it("formats the heterogeneity line (Q/τ² 2dp, I² 0dp, small p as <0.001)", () => {
    const layout = buildForestPlotLayout(
      input({ heterogeneity: { q: 12.34, df: 5, p: 0.0004, i2: 59.4, tau2: 0.031 } }),
    );
    expect(layout.footers[0]?.text).toBe(
      "Heterogeneity: Q=12.34, df=5, p=<0.001; I²=59%; τ²=0.03",
    );
  });

  it("formats moderate p values at 3dp", () => {
    const layout = buildForestPlotLayout(
      input({ heterogeneity: { q: 1.5, df: 2, p: 0.4721, i2: 0, tau2: 0 } }),
    );
    expect(layout.footers[0]?.text).toBe("Heterogeneity: Q=1.50, df=2, p=0.472; I²=0%; τ²=0.00");
  });

  it("renders excluded studies as not-pooled footnotes", () => {
    const layout = buildForestPlotLayout(
      input({ excluded: [{ label: "Study X", reason: "no variance reported" }] }),
    );
    expect(layout.footers.map((f) => f.text)).toContain(
      "Not pooled: Study X — no variance reported",
    );
    expect(forestPlotSvg(layout)).toContain("Not pooled: Study X — no variance reported");
  });
});
