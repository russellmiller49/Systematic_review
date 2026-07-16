// Meta-analysis funnel plot — pure layout + SVG-string rendering (no React, no DOM).
// Mirrors forest-plot-layout.ts: the same SVG string is shown on screen (as an <img>
// data URI) and downloaded, so the on-screen preview is exactly the manuscript figure.
// Palette is the same fixed light/manuscript style.
//
// Geometry: x = per-study effect y_i on the ANALYSIS scale (axis ticks are labeled with
// back-transformed display values, like the forest plot); y = standard error, INVERTED
// (se = 0 at the top). One point per included study, a vertical line at the chosen
// model's pooled estimate ŷ, and the pseudo-95% funnel region x = ŷ ± 1.96·se swept
// from se = 0 down to the axis maximum. Egger's test renders as a footer line (with a
// low-power caveat when k < 10). Study labels are user data — XML-escaped everywhere.

import { ftInverse, invLogit } from "@/lib/stats/effects/proportion";
import { escapeXml, linearTicks, logTicks } from "./forest-plot-layout";
import type { AnalysisScale, EggerResult } from "./types";

// ---------------------------------------------------------------------------
// Input contract (consumed by the analysis UI)
// ---------------------------------------------------------------------------

export interface FunnelPoint {
  label: string;
  y: number; // analysis scale
  se: number;
}

export interface FunnelPlotInput {
  title: string;
  measureLabel: string; // x-axis caption
  scale: AnalysisScale;
  harmonicN: number | null; // FT tick back-transform parameter (scale "ft" only)
  points: FunnelPoint[];
  pooledY: number | null; // chosen model's pooled estimate on the analysis scale
  egger: EggerResult | null;
}

// ---------------------------------------------------------------------------
// Layout types
// ---------------------------------------------------------------------------

export interface FunnelTick {
  x: number;
  label: string;
}

export interface FunnelPointLayout {
  cx: number;
  cy: number;
  label: string;
}

/** Pseudo-95% region triangle: apex at (ŷ, se=0), corners at ŷ ± 1.96·seMax. */
export interface FunnelRegion {
  apex: { x: number; y: number };
  left: { x: number; y: number };
  right: { x: number; y: number };
}

export interface FunnelPlotLayout {
  width: number;
  height: number;
  title: string;
  titleY: number;
  plot: { left: number; right: number; top: number; bottom: number };
  xTicks: FunnelTick[];
  yTicks: { y: number; label: string }[];
  xAxisLabel: { text: string; x: number; y: number };
  yAxisLabel: { text: string; x: number; y: number }; // rendered rotated -90°
  region: FunnelRegion | null;
  pooledLineX: number | null;
  points: FunnelPointLayout[];
  footers: { text: string; y: number }[];
  placeholder: { text: string; x: number; y: number } | null;
}

// ---------------------------------------------------------------------------
// Constants (aligned with forest-plot-layout.ts)
// ---------------------------------------------------------------------------

const WIDTH = 560;
const MARGIN = 16;
const FONT_SIZE = 12;
const TITLE_FONT_SIZE = 14;
const PLOT_HEIGHT = 240;
const GUTTER_LEFT = 52; // room for y tick labels + axis caption
const FOOTER_LINE_HEIGHT = 16;
const POINT_RADIUS = 3;
const Z95 = 1.959963984540054;

// Candidate proportion tick values for the transformed proportion scales.
const PROPORTION_TICK_CANDIDATES = [
  0.01, 0.02, 0.05, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 0.95, 0.98, 0.99,
];

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(Math.max(n, lo), hi);
}

function isNum(v: number | null | undefined): v is number {
  return v != null && Number.isFinite(v);
}

/** Trim trailing zeros so tick labels stay compact ("0.50" -> "0.5"). */
function fmtTickValue(v: number): string {
  if (Number.isInteger(v)) return String(v);
  return String(Number(v.toPrecision(3)));
}

function fmtP(p: number): string {
  return p < 0.001 ? "p < 0.001" : `p = ${p.toFixed(3)}`;
}

// ---------------------------------------------------------------------------
// Analysis-scale <-> display-scale transforms for axis ticks
// ---------------------------------------------------------------------------

const logit = (p: number): number => Math.log(p / (1 - p));

// Forward FT transform of a display proportion at the harmonic-mean n: ftInverse is
// monotone on [0, π/2], so invert it by bisection (deterministic, ~1e-12 precise).
function ftForward(p: number, n: number): number {
  let lo = 0;
  let hi = Math.PI / 2;
  for (let i = 0; i < 60; i++) {
    const mid = (lo + hi) / 2;
    if (ftInverse(mid, n) < p) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}

/**
 * Ticks on the analysis-scale window [lo, hi], labeled with back-transformed display
 * values (mirrors the forest plot's display-labeled axes).
 */
export function funnelTickValues(
  scale: AnalysisScale,
  lo: number,
  hi: number,
  harmonicN: number | null,
): { position: number; label: string }[] {
  if (scale === "log") {
    return logTicks(Math.exp(lo), Math.exp(hi)).map((t) => ({
      position: Math.log(t),
      label: fmtTickValue(t),
    }));
  }
  if (scale === "logit") {
    const ticks = PROPORTION_TICK_CANDIDATES.filter((p) => {
      const y = logit(p);
      return y >= lo && y <= hi;
    }).map((p) => ({ position: logit(p), label: fmtTickValue(p) }));
    if (ticks.length >= 2) return ticks;
    return [lo, hi].map((y) => ({ position: y, label: fmtTickValue(invLogit(y)) }));
  }
  if (scale === "ft") {
    if (harmonicN === null) {
      return linearTicks(lo, hi).map((t) => ({ position: t, label: fmtTickValue(t) }));
    }
    const ticks = PROPORTION_TICK_CANDIDATES.map((p) => ({
      position: ftForward(p, harmonicN),
      label: fmtTickValue(p),
    })).filter((t) => t.position >= lo && t.position <= hi);
    if (ticks.length >= 2) return ticks;
    return [lo, hi].map((y) => ({ position: y, label: fmtTickValue(ftInverse(y, harmonicN)) }));
  }
  return linearTicks(lo, hi).map((t) => ({ position: t, label: fmtTickValue(t) }));
}

// ---------------------------------------------------------------------------
// Layout
// ---------------------------------------------------------------------------

export function buildFunnelPlotLayout(input: FunnelPlotInput): FunnelPlotLayout {
  const titleY = MARGIN + TITLE_FONT_SIZE;
  const plotTop = titleY + 22;
  const plotLeft = MARGIN + GUTTER_LEFT;
  const plotRight = WIDTH - MARGIN - 8;

  const points = input.points.filter((p) => isNum(p.y) && isNum(p.se) && p.se >= 0);
  const isEmpty = points.length === 0;

  if (isEmpty) {
    const placeholderY = plotTop + 40;
    return {
      width: WIDTH,
      height: Math.ceil(placeholderY + 40),
      title: input.title,
      titleY,
      plot: { left: plotLeft, right: plotRight, top: plotTop, bottom: placeholderY + 14 },
      xTicks: [],
      yTicks: [],
      xAxisLabel: { text: input.measureLabel, x: (plotLeft + plotRight) / 2, y: placeholderY + 40 },
      yAxisLabel: { text: "Standard error", x: MARGIN + 10, y: (plotTop + placeholderY) / 2 },
      region: null,
      pooledLineX: null,
      points: [],
      footers: [],
      placeholder: { text: "No studies pooled yet", x: (plotLeft + plotRight) / 2, y: placeholderY },
    };
  }

  // ---- windows ----
  const seMax = Math.max(...points.map((p) => p.se));
  const seTop = seMax > 0 ? seMax * 1.08 : 1; // y axis: 0 (top) .. seTop (bottom)

  const xValues: number[] = points.map((p) => p.y);
  if (isNum(input.pooledY)) {
    xValues.push(input.pooledY, input.pooledY - Z95 * seTop, input.pooledY + Z95 * seTop);
  }
  let xLo = Math.min(...xValues);
  let xHi = Math.max(...xValues);
  if (xLo === xHi) {
    const half = Math.max(Math.abs(xLo) * 0.5, 1);
    xLo -= half;
    xHi += half;
  }
  const xPad = (xHi - xLo) * 0.06;
  xLo -= xPad;
  xHi += xPad;

  const plotBottom = plotTop + PLOT_HEIGHT;
  const toX = (v: number): number => plotLeft + ((v - xLo) / (xHi - xLo)) * (plotRight - plotLeft);
  const toY = (se: number): number => plotTop + (se / seTop) * PLOT_HEIGHT; // inverted: se 0 on top

  // ---- funnel region + pooled line ----
  let region: FunnelRegion | null = null;
  let pooledLineX: number | null = null;
  if (isNum(input.pooledY)) {
    const px = toX(input.pooledY);
    if (px >= plotLeft - 0.5 && px <= plotRight + 0.5) pooledLineX = clamp(px, plotLeft, plotRight);
    region = {
      apex: { x: clamp(px, plotLeft, plotRight), y: plotTop },
      left: { x: clamp(toX(input.pooledY - Z95 * seTop), plotLeft, plotRight), y: plotBottom },
      right: { x: clamp(toX(input.pooledY + Z95 * seTop), plotLeft, plotRight), y: plotBottom },
    };
  }

  // ---- ticks ----
  const xTicks: FunnelTick[] = funnelTickValues(input.scale, xLo, xHi, input.harmonicN).map(
    (t) => ({ x: clamp(toX(t.position), plotLeft, plotRight), label: t.label }),
  );
  const yTicks = linearTicks(0, seTop, 5).map((se) => ({ y: toY(se), label: fmtTickValue(se) }));

  // ---- points ----
  const pointLayouts: FunnelPointLayout[] = points.map((p) => ({
    cx: clamp(toX(p.y), plotLeft, plotRight),
    cy: clamp(toY(p.se), plotTop, plotBottom),
    label: p.label,
  }));

  // ---- axis captions + footers ----
  const tickLabelY = plotBottom + 16;
  const xAxisLabelY = tickLabelY + 18;
  const footerTexts: string[] = [];
  if (input.egger) {
    footerTexts.push(
      `Egger's test: intercept ${input.egger.intercept.toFixed(2)} (${fmtP(input.egger.p)})`,
    );
    if (input.egger.k < 10) {
      footerTexts.push(`k = ${input.egger.k} < 10 — low power to detect asymmetry`);
    }
  } else if (input.points.length < 3) {
    footerTexts.push("Egger's test requires at least 3 pooled studies");
  } else {
    // eggerTest also returns null for a degenerate k >= 3 fit (identical study
    // precisions make the intercept unidentifiable) — don't claim k < 3 then.
    footerTexts.push("Egger's test not estimable (studies have identical precision)");
  }
  const footersTop = xAxisLabelY + 22;
  const footers = footerTexts.map((text, i) => ({ text, y: footersTop + i * FOOTER_LINE_HEIGHT }));
  const bottom = footers[footers.length - 1]?.y ?? xAxisLabelY;

  return {
    width: WIDTH,
    height: Math.ceil(bottom + MARGIN),
    title: input.title,
    titleY,
    plot: { left: plotLeft, right: plotRight, top: plotTop, bottom: plotBottom },
    xTicks,
    yTicks,
    xAxisLabel: { text: input.measureLabel, x: (plotLeft + plotRight) / 2, y: xAxisLabelY },
    yAxisLabel: { text: "Standard error", x: MARGIN + 10, y: (plotTop + plotBottom) / 2 },
    region,
    pooledLineX,
    points: pointLayouts,
    footers,
    placeholder: null,
  };
}

// ---------------------------------------------------------------------------
// SVG rendering
// ---------------------------------------------------------------------------

const PALETTE = {
  background: "#ffffff",
  text: "#0f172a",
  muted: "#475569",
  rule: "#cbd5e1",
  axis: "#475569",
  region: "#f1f5f9",
  regionEdge: "#94a3b8",
  pooledLine: "#94a3b8",
  marker: "#334155",
};

/** Compact numeric attribute value (2dp keeps the SVG readable and small). */
function nf(n: number): string {
  return String(Math.round(n * 100) / 100);
}

/** Render the layout as a standalone SVG document string. */
export function funnelPlotSvg(layout: FunnelPlotLayout): string {
  const parts: string[] = [];
  parts.push(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${layout.width} ${layout.height}" ` +
      `width="${layout.width}" height="${layout.height}" ` +
      `font-family="Helvetica, Arial, sans-serif" font-size="${FONT_SIZE}">`,
    `<title>${escapeXml(layout.title)}</title>`,
    `<rect width="${layout.width}" height="${layout.height}" fill="${PALETTE.background}"/>`,
    `<text x="${MARGIN}" y="${nf(layout.titleY)}" font-size="${TITLE_FONT_SIZE}" ` +
      `font-weight="600" fill="${PALETTE.text}">${escapeXml(layout.title)}</text>`,
  );

  if (layout.placeholder) {
    parts.push(
      `<text x="${nf(layout.placeholder.x)}" y="${nf(layout.placeholder.y)}" ` +
        `fill="${PALETTE.muted}" text-anchor="middle">${escapeXml(layout.placeholder.text)}</text>`,
    );
    parts.push(`</svg>`);
    return parts.join("");
  }

  const { plot } = layout;

  // Pseudo-95% region behind everything else.
  if (layout.region) {
    const { apex, left, right } = layout.region;
    parts.push(
      `<polygon points="${nf(apex.x)},${nf(apex.y)} ${nf(left.x)},${nf(left.y)} ` +
        `${nf(right.x)},${nf(right.y)}" fill="${PALETTE.region}"/>`,
      `<line x1="${nf(apex.x)}" y1="${nf(apex.y)}" x2="${nf(left.x)}" y2="${nf(left.y)}" ` +
        `stroke="${PALETTE.regionEdge}" stroke-dasharray="4 3"/>`,
      `<line x1="${nf(apex.x)}" y1="${nf(apex.y)}" x2="${nf(right.x)}" y2="${nf(right.y)}" ` +
        `stroke="${PALETTE.regionEdge}" stroke-dasharray="4 3"/>`,
    );
  }
  if (layout.pooledLineX != null) {
    parts.push(
      `<line x1="${nf(layout.pooledLineX)}" y1="${nf(plot.top)}" x2="${nf(layout.pooledLineX)}" ` +
        `y2="${nf(plot.bottom)}" stroke="${PALETTE.pooledLine}"/>`,
    );
  }

  // Axes.
  parts.push(
    `<line x1="${nf(plot.left)}" y1="${nf(plot.bottom)}" x2="${nf(plot.right)}" ` +
      `y2="${nf(plot.bottom)}" stroke="${PALETTE.axis}"/>`,
    `<line x1="${nf(plot.left)}" y1="${nf(plot.top)}" x2="${nf(plot.left)}" ` +
      `y2="${nf(plot.bottom)}" stroke="${PALETTE.axis}"/>`,
  );
  for (const tick of layout.xTicks) {
    parts.push(
      `<line x1="${nf(tick.x)}" y1="${nf(plot.bottom)}" x2="${nf(tick.x)}" ` +
        `y2="${nf(plot.bottom + 4)}" stroke="${PALETTE.axis}"/>`,
      `<text x="${nf(tick.x)}" y="${nf(plot.bottom + 16)}" font-size="11" ` +
        `fill="${PALETTE.muted}" text-anchor="middle">${escapeXml(tick.label)}</text>`,
    );
  }
  for (const tick of layout.yTicks) {
    parts.push(
      `<line x1="${nf(plot.left - 4)}" y1="${nf(tick.y)}" x2="${nf(plot.left)}" ` +
        `y2="${nf(tick.y)}" stroke="${PALETTE.axis}"/>`,
      `<text x="${nf(plot.left - 7)}" y="${nf(tick.y)}" font-size="11" fill="${PALETTE.muted}" ` +
        `text-anchor="end" dominant-baseline="central">${escapeXml(tick.label)}</text>`,
    );
  }
  parts.push(
    `<text x="${nf(layout.xAxisLabel.x)}" y="${nf(layout.xAxisLabel.y)}" font-size="11" ` +
      `fill="${PALETTE.muted}" text-anchor="middle">${escapeXml(layout.xAxisLabel.text)}</text>`,
    `<text x="${nf(layout.yAxisLabel.x)}" y="${nf(layout.yAxisLabel.y)}" font-size="11" ` +
      `fill="${PALETTE.muted}" text-anchor="middle" ` +
      `transform="rotate(-90 ${nf(layout.yAxisLabel.x)} ${nf(layout.yAxisLabel.y)})">` +
      `${escapeXml(layout.yAxisLabel.text)}</text>`,
  );

  // Study points (hover tooltips carry the escaped study label).
  for (const point of layout.points) {
    parts.push(
      `<circle cx="${nf(point.cx)}" cy="${nf(point.cy)}" r="${POINT_RADIUS}" ` +
        `fill="${PALETTE.marker}"><title>${escapeXml(point.label)}</title></circle>`,
    );
  }

  for (const footer of layout.footers) {
    parts.push(
      `<text x="${MARGIN}" y="${nf(footer.y)}" font-size="11" fill="${PALETTE.muted}">` +
        `${escapeXml(footer.text)}</text>`,
    );
  }

  parts.push(`</svg>`);
  return parts.join("");
}
