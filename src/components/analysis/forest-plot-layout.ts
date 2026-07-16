// Meta-analysis forest plot — pure layout + SVG-string rendering (no React, no DOM).
// Mirrors src/components/prisma/diagram-layout.ts: the same SVG string is shown on
// screen (as an <img> data URI) and downloaded, so the on-screen preview is exactly
// the manuscript figure. Palette is fixed light/manuscript style on purpose: the plot
// is a document artifact, not a themed UI surface.
//
// Geometry: left text columns (study label, per-outcome data columns, effect text,
// weight), then the plot band with per-row CI whiskers, weight-proportional squares
// (AREA proportional to weightPct), a pooled diamond, a vertical null line, and an
// axis (pretty log ticks or nice linear ticks). CIs outside the axis window are
// clipped with arrowheads. Study labels, data cells, and exclusion reasons are user
// data — everything is XML-escaped in the renderer.

// ---------------------------------------------------------------------------
// Input contract (consumed by the analysis UI)
// ---------------------------------------------------------------------------

export interface ForestPlotRow {
  label: string;
  estimate: number | null;
  ciLow: number | null;
  ciHigh: number | null;
  weightPct: number | null;
  dataCols: string[];
  provisional?: boolean;
}

export interface ForestPlotInput {
  title: string;
  measureLabel: string;
  scale: "log" | "linear";
  nullValue: number | null;
  favours?: { left: string; right: string };
  columnHeaders: string[]; // headers for dataCols
  rows: ForestPlotRow[];
  pooled: { label: string; estimate: number; ciLow: number; ciHigh: number } | null; // display scale
  heterogeneity: { q: number; df: number; p: number; i2: number; tau2: number } | null;
  excluded: { label: string; reason: string }[];
}

// ---------------------------------------------------------------------------
// Layout types
// ---------------------------------------------------------------------------

export interface ForestCell {
  text: string;
  x: number;
  anchor: "start" | "middle" | "end";
  bold?: boolean;
}

export interface ForestCi {
  x1: number;
  x2: number;
  arrowLeft: boolean; // CI extends below the axis window — draw a left arrowhead
  arrowRight: boolean;
}

export interface ForestSquare {
  cx: number;
  half: number; // half of the square side; area = (2*half)^2 ∝ weightPct
  dashed: boolean; // provisional rows get a dashed outline instead of a solid fill
}

export interface ForestRowLayout {
  centerY: number;
  cells: ForestCell[];
  square: ForestSquare | null;
  ci: ForestCi | null;
}

export interface ForestPoint {
  x: number;
  y: number;
}

/** Pooled-effect diamond: points in order [left, top, right, bottom]; top/bottom sit on the estimate. */
export interface ForestDiamond {
  centerY: number;
  cells: ForestCell[];
  points: [ForestPoint, ForestPoint, ForestPoint, ForestPoint];
}

export interface ForestTick {
  x: number;
  label: string;
}

export interface ForestAxis {
  y: number;
  tickLabelY: number;
  ticks: ForestTick[];
  nullLineX: number | null; // null when nullValue is null or off-window
  favours: { text: string; x: number; y: number }[];
}

export interface ForestPlotLayout {
  width: number;
  height: number;
  title: string;
  titleY: number;
  headerY: number;
  headerRuleY: number;
  headerCells: ForestCell[];
  plot: { left: number; right: number; top: number; bottom: number };
  axis: ForestAxis | null; // null in the empty-plot placeholder state
  rows: ForestRowLayout[];
  diamond: ForestDiamond | null;
  footers: { text: string; y: number }[];
  placeholder: { text: string; x: number; y: number } | null;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const WIDTH = 900;
const MARGIN = 16;
const FONT_SIZE = 12;
const TITLE_FONT_SIZE = 14;
const ROW_HEIGHT = 22;
const COL_GAP = 14;
const PLOT_GAP = 18; // extra breathing room between the last text column and the plot band
const MIN_PLOT_WIDTH = 220;
const POOLED_GAP = 6;
const FOOTER_LINE_HEIGHT = 16;
const ARROW_LENGTH = 7;
const MIN_SQUARE_HALF = 2.5;
const MAX_SQUARE_HALF = 6.5;
const DIAMOND_HALF_HEIGHT = 6;

// Approximate character width for column sizing (SVG has no text measurement here);
// 0.52em per character is conservative for Helvetica/Arial at this size.
const CHAR_W = FONT_SIZE * 0.52;

// Log-scale display window is clamped to [0.01, 100]; CIs beyond it get arrowheads.
const LOG_LO = -2;
const LOG_HI = 2;

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

export function escapeXml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(Math.max(n, lo), hi);
}

function isNum(v: number | null | undefined): v is number {
  return v != null && Number.isFinite(v);
}

function maxLen(texts: string[]): number {
  let max = 0;
  for (const t of texts) max = Math.max(max, t.length);
  return max;
}

function truncate(text: string, maxChars: number): string {
  return text.length > maxChars ? `${text.slice(0, Math.max(maxChars - 1, 1))}…` : text;
}

/** "0.49 [0.32, 0.76]" — em dash when the estimate is missing, bare estimate when the CI is. */
function effectText(estimate: number | null, ciLow: number | null, ciHigh: number | null): string {
  if (!isNum(estimate)) return "—";
  if (!isNum(ciLow) || !isNum(ciHigh)) return estimate.toFixed(2);
  return `${estimate.toFixed(2)} [${ciLow.toFixed(2)}, ${ciHigh.toFixed(2)}]`;
}

/** Q/τ² 2dp, I² 0dp, p 3dp or "<0.001" (spec'd footer format). */
function heterogeneityText(h: { q: number; df: number; p: number; i2: number; tau2: number }): string {
  const p = h.p < 0.001 ? "<0.001" : h.p.toFixed(3);
  return `Heterogeneity: Q=${h.q.toFixed(2)}, df=${h.df}, p=${p}; I²=${Math.round(h.i2)}%; τ²=${h.tau2.toFixed(2)}`;
}

// ---------------------------------------------------------------------------
// Axis ticks + windows
// ---------------------------------------------------------------------------

const LOG_TICK_CANDIDATES = [0.01, 0.02, 0.05, 0.1, 0.2, 0.5, 1, 2, 5, 10, 20, 50, 100];

/** "Pretty" 1/2/5 log ticks filtered to [lo, hi]; falls back to the endpoints if too few remain. */
export function logTicks(lo: number, hi: number): number[] {
  const ticks = LOG_TICK_CANDIDATES.filter((t) => t >= lo * 0.999 && t <= hi * 1.001);
  if (ticks.length >= 2) return ticks;
  return [lo, hi].map((v) => Number(v.toPrecision(2)));
}

/** Standard nice linear ticks (1/2/5 × 10^k step), rounded so labels stringify cleanly. */
export function linearTicks(lo: number, hi: number, target = 6): number[] {
  const span = hi - lo;
  if (!Number.isFinite(span) || span <= 0) return [lo];
  const raw = span / Math.max(target - 1, 1);
  const mag = 10 ** Math.floor(Math.log10(raw));
  const norm = raw / mag;
  const step = (norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 5 ? 5 : 10) * mag;
  const decimals = Math.max(0, -Math.floor(Math.log10(step)));
  const start = Math.ceil(lo / step) * step;
  const out: number[] = [];
  for (let i = 0; i < 50; i++) {
    const v = start + i * step;
    if (v > hi + step * 1e-6) break;
    out.push(Number(v.toFixed(decimals)));
  }
  return out.length > 0 ? out : [lo];
}

/** Every finite value that must fit in the axis window (log scale keeps positives only). */
function collectWindowValues(input: ForestPlotInput): number[] {
  const vals: number[] = [];
  for (const r of input.rows) {
    for (const v of [r.estimate, r.ciLow, r.ciHigh]) if (isNum(v)) vals.push(v);
  }
  if (input.pooled) vals.push(input.pooled.estimate, input.pooled.ciLow, input.pooled.ciHigh);
  if (isNum(input.nullValue)) vals.push(input.nullValue);
  return input.scale === "log" ? vals.filter((v) => v > 0) : vals;
}

/** Padded log window, clamped to [0.01, 100]; degenerate windows are widened around their midpoint. */
function logWindow(vals: number[]): [number, number] {
  const lo = vals.length > 0 ? Math.min(...vals) : 0.5;
  const hi = vals.length > 0 ? Math.max(...vals) : 2;
  let lLo = Math.log10(lo);
  let lHi = Math.log10(hi);
  const pad = Math.max((lHi - lLo) * 0.08, 0.08);
  lLo = Math.max(lLo - pad, LOG_LO);
  lHi = Math.min(lHi + pad, LOG_HI);
  if (lHi - lLo < 0.3) {
    const mid = (lLo + lHi) / 2;
    lLo = mid - 0.15;
    lHi = mid + 0.15;
    if (lLo < LOG_LO) {
      lHi += LOG_LO - lLo;
      lLo = LOG_LO;
    }
    if (lHi > LOG_HI) {
      lLo = Math.max(lLo - (lHi - LOG_HI), LOG_LO);
      lHi = LOG_HI;
    }
  }
  return [10 ** lLo, 10 ** lHi];
}

/** Padded linear window; a zero-span window is widened so the axis never degenerates. */
function linearWindow(vals: number[]): [number, number] {
  let lo = vals.length > 0 ? Math.min(...vals) : -1;
  let hi = vals.length > 0 ? Math.max(...vals) : 1;
  if (lo === hi) {
    const half = Math.max(Math.abs(lo) * 0.5, 1);
    lo -= half;
    hi += half;
  }
  const pad = (hi - lo) * 0.06;
  return [lo - pad, hi + pad];
}

// ---------------------------------------------------------------------------
// Layout
// ---------------------------------------------------------------------------

export function buildForestPlotLayout(input: ForestPlotInput): ForestPlotLayout {
  // ---- per-row display text (needed before column sizing) ----
  const rowData = input.rows.map((row) => ({
    row,
    label: row.provisional ? `${row.label} (provisional)` : row.label,
    effect: effectText(row.estimate, row.ciLow, row.ciHigh),
    weight: isNum(row.weightPct) ? `${row.weightPct.toFixed(1)}%` : "—",
  }));
  const effectHeader = `${input.measureLabel} [95% CI]`;
  const pooledEffect = input.pooled
    ? effectText(input.pooled.estimate, input.pooled.ciLow, input.pooled.ciHigh)
    : "";

  // ---- column geometry (left to right: label, dataCols, effect, weight, plot band) ----
  const headerCells: ForestCell[] = [];
  let cursorX = MARGIN;

  const labelTexts = ["Study", ...rowData.map((d) => d.label)];
  if (input.pooled) labelTexts.push(input.pooled.label);
  const labelW = clamp(maxLen(labelTexts) * CHAR_W + 4, 110, 250);
  const labelX = cursorX;
  const labelMaxChars = Math.floor(labelW / CHAR_W);
  headerCells.push({ text: "Study", x: labelX, anchor: "start", bold: true });
  cursorX += labelW;

  const dataColumns = input.columnHeaders.map((header, i) => {
    const w = clamp(
      maxLen([header, ...input.rows.map((r) => r.dataCols[i] ?? "")]) * CHAR_W + 4,
      44,
      110,
    );
    cursorX += COL_GAP;
    const center = cursorX + w / 2;
    cursorX += w;
    headerCells.push({ text: header, x: center, anchor: "middle", bold: true });
    return { index: i, center, maxChars: Math.floor(w / CHAR_W) };
  });

  const effectW = clamp(
    maxLen([effectHeader, pooledEffect, ...rowData.map((d) => d.effect)]) * CHAR_W + 4,
    100,
    190,
  );
  cursorX += COL_GAP;
  const effectX = cursorX + effectW; // right-aligned
  cursorX += effectW;
  headerCells.push({ text: effectHeader, x: effectX, anchor: "end", bold: true });

  const weightW = clamp(maxLen(["Weight", ...rowData.map((d) => d.weight)]) * CHAR_W + 4, 44, 64);
  cursorX += COL_GAP;
  const weightX = cursorX + weightW; // right-aligned
  cursorX += weightW;
  headerCells.push({ text: "Weight", x: weightX, anchor: "end", bold: true });

  const plotLeft = cursorX + PLOT_GAP;
  const width = Math.max(WIDTH, plotLeft + MIN_PLOT_WIDTH + MARGIN);
  const plotRight = width - MARGIN;

  const textCells = (
    label: string,
    dataCols: string[],
    effect: string,
    weight: string | null,
    bold?: boolean,
  ): ForestCell[] => {
    const cells: ForestCell[] = [
      { text: truncate(label, labelMaxChars), x: labelX, anchor: "start", bold },
    ];
    for (const col of dataColumns) {
      cells.push({
        text: truncate(dataCols[col.index] ?? "", col.maxChars),
        x: col.center,
        anchor: "middle",
        bold,
      });
    }
    cells.push({ text: effect, x: effectX, anchor: "end", bold });
    if (weight !== null) cells.push({ text: weight, x: weightX, anchor: "end", bold });
    return cells;
  };

  // ---- scale: display value -> x within the plot band ----
  const values = collectWindowValues(input);
  const [windowLo, windowHi] = input.scale === "log" ? logWindow(values) : linearWindow(values);
  const plotW = plotRight - plotLeft;
  const toX =
    input.scale === "log"
      ? (v: number) =>
          plotLeft +
          ((Math.log10(v) - Math.log10(windowLo)) / (Math.log10(windowHi) - Math.log10(windowLo))) *
            plotW
      : (v: number) => plotLeft + ((v - windowLo) / (windowHi - windowLo)) * plotW;
  // Non-positive values on a log scale sit infinitely far left — they clip with an arrow.
  const xOf = (v: number): number =>
    input.scale === "log" && v <= 0 ? Number.NEGATIVE_INFINITY : toX(v);

  // ---- vertical layout ----
  const titleY = MARGIN + TITLE_FONT_SIZE;
  const headerY = titleY + 28;
  const headerRuleY = headerY + 8;
  const rowsTop = headerRuleY + 6;
  const rowsBottom = rowsTop + input.rows.length * ROW_HEIGHT;

  // ---- squares: AREA ∝ weightPct, scaled to the largest weight, clamped ----
  const finiteWeights = rowData
    .map((d) => d.row.weightPct)
    .filter((w): w is number => isNum(w) && w > 0);
  const maxWeight = finiteWeights.length > 0 ? Math.max(...finiteWeights) : 0;
  const squareHalf = (w: number | null): number => {
    if (!isNum(w) || w <= 0 || maxWeight <= 0) return (MIN_SQUARE_HALF + MAX_SQUARE_HALF) / 2;
    return clamp(MAX_SQUARE_HALF * Math.sqrt(w / maxWeight), MIN_SQUARE_HALF, MAX_SQUARE_HALF);
  };

  // ---- study rows ----
  const rows: ForestRowLayout[] = rowData.map((d, i) => {
    const centerY = rowsTop + i * ROW_HEIGHT + ROW_HEIGHT / 2;

    let ci: ForestCi | null = null;
    if (isNum(d.row.ciLow) && isNum(d.row.ciHigh)) {
      const rawLo = xOf(d.row.ciLow);
      const rawHi = xOf(d.row.ciHigh);
      ci = {
        x1: clamp(rawLo, plotLeft, plotRight),
        x2: clamp(rawHi, plotLeft, plotRight),
        arrowLeft: rawLo < plotLeft - 0.5,
        arrowRight: rawHi > plotRight + 0.5,
      };
    }

    let square: ForestSquare | null = null;
    if (isNum(d.row.estimate)) {
      const cx = xOf(d.row.estimate);
      if (cx >= plotLeft && cx <= plotRight) {
        square = { cx, half: squareHalf(d.row.weightPct), dashed: d.row.provisional === true };
      }
    }

    return {
      centerY,
      cells: textCells(d.label, d.row.dataCols, d.effect, d.weight),
      square,
      ci,
    };
  });

  // ---- pooled diamond ----
  let diamond: ForestDiamond | null = null;
  let plotBottom = rowsBottom;
  if (input.pooled) {
    const centerY = rowsBottom + POOLED_GAP + ROW_HEIGHT / 2;
    plotBottom = rowsBottom + POOLED_GAP + ROW_HEIGHT;
    const xEst = clamp(xOf(input.pooled.estimate), plotLeft, plotRight);
    const xLo = clamp(xOf(input.pooled.ciLow), plotLeft, plotRight);
    const xHi = clamp(xOf(input.pooled.ciHigh), plotLeft, plotRight);
    diamond = {
      centerY,
      cells: textCells(input.pooled.label, [], pooledEffect, null, true),
      points: [
        { x: xLo, y: centerY },
        { x: xEst, y: centerY - DIAMOND_HALF_HEIGHT },
        { x: xHi, y: centerY },
        { x: xEst, y: centerY + DIAMOND_HALF_HEIGHT },
      ],
    };
  }

  // ---- footers: heterogeneity line, then per-study "not pooled" footnotes ----
  const footerTexts: string[] = [];
  if (input.heterogeneity) footerTexts.push(heterogeneityText(input.heterogeneity));
  for (const e of input.excluded) footerTexts.push(`Not pooled: ${e.label} — ${e.reason}`);

  // ---- empty state: no rows and no pooled effect -> placeholder, no axis ----
  const isEmpty = input.rows.length === 0 && input.pooled === null;

  let axis: ForestAxis | null = null;
  let placeholder: ForestPlotLayout["placeholder"] = null;
  let bottom: number;
  let footersTop: number;

  if (isEmpty) {
    placeholder = { text: "No studies pooled yet", x: width / 2, y: rowsTop + 26 };
    bottom = placeholder.y;
    footersTop = placeholder.y + 26;
  } else {
    const axisY = plotBottom + 8;
    const tickLabelY = axisY + 18;
    const tickValues =
      input.scale === "log" ? logTicks(windowLo, windowHi) : linearTicks(windowLo, windowHi);
    const ticks: ForestTick[] = tickValues
      .filter((t) => (input.scale === "log" ? t > 0 : true))
      .map((t) => ({ x: clamp(toX(t), plotLeft, plotRight), label: String(t) }));

    let nullLineX: number | null = null;
    if (isNum(input.nullValue)) {
      const nx = xOf(input.nullValue);
      if (nx >= plotLeft - 0.5 && nx <= plotRight + 0.5) nullLineX = clamp(nx, plotLeft, plotRight);
    }

    const favours: ForestAxis["favours"] = [];
    let favoursBottom = tickLabelY;
    if (input.favours) {
      const mid = nullLineX ?? (plotLeft + plotRight) / 2;
      const favoursY = tickLabelY + 17;
      favours.push(
        { text: input.favours.left, x: (plotLeft + mid) / 2, y: favoursY },
        { text: input.favours.right, x: (mid + plotRight) / 2, y: favoursY },
      );
      favoursBottom = favoursY;
    }

    axis = { y: axisY, tickLabelY, ticks, nullLineX, favours };
    bottom = favoursBottom;
    footersTop = favoursBottom + 24;
  }

  const footers = footerTexts.map((text, i) => ({ text, y: footersTop + i * FOOTER_LINE_HEIGHT }));
  const lastFooter = footers[footers.length - 1];
  if (lastFooter) bottom = lastFooter.y;

  return {
    width,
    height: Math.ceil(bottom + MARGIN),
    title: input.title,
    titleY,
    headerY,
    headerRuleY,
    headerCells,
    plot: { left: plotLeft, right: plotRight, top: rowsTop, bottom: plotBottom },
    axis,
    rows,
    diamond,
    footers,
    placeholder,
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
  nullLine: "#94a3b8",
  marker: "#334155",
  diamond: "#0f172a",
};

/** Compact numeric attribute value (2dp keeps the SVG readable and small). */
function nf(n: number): string {
  return String(Math.round(n * 100) / 100);
}

function cellSvg(cell: ForestCell, y: number, centered: boolean): string {
  const weight = cell.bold ? ` font-weight="600"` : "";
  const anchor = cell.anchor === "start" ? "" : ` text-anchor="${cell.anchor}"`;
  const baseline = centered ? ` dominant-baseline="central"` : "";
  return (
    `<text x="${nf(cell.x)}" y="${nf(y)}" fill="${PALETTE.text}"${weight}${anchor}${baseline}>` +
    `${escapeXml(cell.text)}</text>`
  );
}

/** Arrowhead for a clipped CI; direction +1 points left (tip at the left edge), -1 points right. */
function arrowSvg(tipX: number, cy: number, direction: 1 | -1): string {
  const baseX = tipX + direction * ARROW_LENGTH;
  return (
    `<polygon points="${nf(tipX)},${nf(cy)} ${nf(baseX)},${nf(cy - 3.5)} ${nf(baseX)},${nf(cy + 3.5)}" ` +
    `fill="${PALETTE.marker}"/>`
  );
}

/** Render the layout as a standalone SVG document string. */
export function forestPlotSvg(layout: ForestPlotLayout): string {
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

  for (const cell of layout.headerCells) parts.push(cellSvg(cell, layout.headerY, false));
  parts.push(
    `<line x1="${MARGIN}" y1="${nf(layout.headerRuleY)}" x2="${nf(layout.width - MARGIN)}" ` +
      `y2="${nf(layout.headerRuleY)}" stroke="${PALETTE.rule}"/>`,
  );

  const axis = layout.axis;
  if (axis) {
    if (axis.nullLineX != null) {
      parts.push(
        `<line x1="${nf(axis.nullLineX)}" y1="${nf(layout.plot.top)}" ` +
          `x2="${nf(axis.nullLineX)}" y2="${nf(axis.y)}" stroke="${PALETTE.nullLine}"/>`,
      );
    }
    parts.push(
      `<line x1="${nf(layout.plot.left)}" y1="${nf(axis.y)}" x2="${nf(layout.plot.right)}" ` +
        `y2="${nf(axis.y)}" stroke="${PALETTE.axis}"/>`,
    );
    for (const tick of axis.ticks) {
      parts.push(
        `<line x1="${nf(tick.x)}" y1="${nf(axis.y)}" x2="${nf(tick.x)}" y2="${nf(axis.y + 4)}" ` +
          `stroke="${PALETTE.axis}"/>`,
        `<text x="${nf(tick.x)}" y="${nf(axis.tickLabelY)}" font-size="11" fill="${PALETTE.muted}" ` +
          `text-anchor="middle">${escapeXml(tick.label)}</text>`,
      );
    }
    for (const f of axis.favours) {
      parts.push(
        `<text x="${nf(f.x)}" y="${nf(f.y)}" font-size="11" fill="${PALETTE.muted}" ` +
          `text-anchor="middle">${escapeXml(f.text)}</text>`,
      );
    }
  }

  for (const row of layout.rows) {
    if (row.ci) {
      parts.push(
        `<line x1="${nf(row.ci.x1)}" y1="${nf(row.centerY)}" x2="${nf(row.ci.x2)}" ` +
          `y2="${nf(row.centerY)}" stroke="${PALETTE.marker}" stroke-width="1.2"/>`,
      );
      if (row.ci.arrowLeft) parts.push(arrowSvg(row.ci.x1, row.centerY, 1));
      if (row.ci.arrowRight) parts.push(arrowSvg(row.ci.x2, row.centerY, -1));
    }
    if (row.square) {
      const { cx, half, dashed } = row.square;
      const style = dashed
        ? `fill="${PALETTE.background}" stroke="${PALETTE.marker}" stroke-dasharray="3 2"`
        : `fill="${PALETTE.marker}"`;
      parts.push(
        `<rect x="${nf(cx - half)}" y="${nf(row.centerY - half)}" width="${nf(half * 2)}" ` +
          `height="${nf(half * 2)}" ${style}/>`,
      );
    }
    for (const cell of row.cells) parts.push(cellSvg(cell, row.centerY, true));
  }

  if (layout.diamond) {
    const pts = layout.diamond.points.map((p) => `${nf(p.x)},${nf(p.y)}`).join(" ");
    parts.push(`<polygon points="${pts}" fill="${PALETTE.diamond}"/>`);
    for (const cell of layout.diamond.cells) parts.push(cellSvg(cell, layout.diamond.centerY, true));
  }

  for (const footer of layout.footers) {
    parts.push(
      `<text x="${MARGIN}" y="${nf(footer.y)}" font-size="11" fill="${PALETTE.muted}">` +
        `${escapeXml(footer.text)}</text>`,
    );
  }

  if (layout.placeholder) {
    parts.push(
      `<text x="${nf(layout.placeholder.x)}" y="${nf(layout.placeholder.y)}" ` +
        `fill="${PALETTE.muted}" text-anchor="middle">${escapeXml(layout.placeholder.text)}</text>`,
    );
  }

  parts.push(`</svg>`);
  return parts.join("");
}
