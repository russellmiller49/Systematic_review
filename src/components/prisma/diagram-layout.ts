// PRISMA 2020 flow diagram — pure layout + SVG-string rendering (no React, no DOM).
// The same SVG string is shown on screen (as an <img> data URI) and downloaded, so the
// on-screen preview is exactly the manuscript figure. Palette is fixed light/manuscript
// style on purpose: the diagram is a document artifact, not a themed UI surface.
//
// Counts come from the PRISMA report (live or snapshot) by key; missing keys render as 0
// so a fresh project still shows the full template. Source names and exclusion-reason
// labels are user data — everything is XML-escaped in the renderer.

export interface DiagramCountRow {
  key: string;
  value: number;
  breakdown?: Record<string, number> | null;
}

export interface DiagramLine {
  text: string;
  bold?: boolean;
  indent?: boolean;
}

export interface DiagramBox {
  x: number;
  y: number;
  width: number;
  height: number;
  lines: DiagramLine[];
}

export interface DiagramArrow {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

export interface DiagramStageBar {
  x: number;
  y: number;
  width: number;
  height: number;
  label: string;
}

export interface PrismaDiagramLayout {
  width: number;
  height: number;
  boxes: DiagramBox[];
  arrows: DiagramArrow[];
  bars: DiagramStageBar[];
}

const FONT_SIZE = 13;
const LINE_HEIGHT = 18;
const PAD_X = 12;
const PAD_Y = 10;
const BOX_WIDTH = 300;
const COL_GAP = 46; // lane between the two box columns, where the right arrows live
const BAR_WIDTH = 34;
const BAR_GAP = 14;
const MARGIN = 14;
const ROW_GAP = 30;
const INDENT = 14;

// Approximate character budget for word wrapping (SVG has no native wrap). 0.52em per
// character is conservative for Helvetica/Arial at this size, plus box padding.
const AVG_CHAR_WIDTH = FONT_SIZE * 0.52;
const MAX_CHARS = Math.floor((BOX_WIDTH - 2 * PAD_X) / AVG_CHAR_WIDTH);
const MAX_CHARS_INDENTED = Math.floor((BOX_WIDTH - 2 * PAD_X - INDENT) / AVG_CHAR_WIDTH);

/**
 * Greedy word wrap; words longer than the budget are hard-broken. Only regular spaces
 * break — the "(n = X)" groups use non-breaking spaces so a wrap never splits a count.
 */
export function wrapText(text: string, maxChars: number): string[] {
  const lines: string[] = [];
  let current = "";
  const push = () => {
    if (current !== "") {
      lines.push(current);
      current = "";
    }
  };
  for (const word of text.split(" ").filter((w) => w !== "")) {
    let piece = word;
    while (piece.length > maxChars) {
      push();
      lines.push(piece.slice(0, maxChars));
      piece = piece.slice(maxChars);
    }
    if (current === "") current = piece;
    else if (current.length + 1 + piece.length <= maxChars) current += ` ${piece}`;
    else {
      push();
      current = piece;
    }
  }
  push();
  return lines.length > 0 ? lines : [""];
}

function fmt(n: number): string {
  return n.toLocaleString("en-US");
}

// Non-breaking spaces (\u00A0) keep the whole "(n = X)" group on one line when wrapping.
function countLine(label: string, value: number): string {
  return `${label} (n\u00A0=\u00A0${fmt(value)})`;
}

/** Wrap logical lines into physical lines, preserving bold/indent flags. */
function wrapLines(lines: DiagramLine[]): DiagramLine[] {
  return lines.flatMap((line) =>
    wrapText(line.text, line.indent ? MAX_CHARS_INDENTED : MAX_CHARS).map((text) => ({
      text,
      bold: line.bold,
      indent: line.indent,
    })),
  );
}

function boxHeight(lines: DiagramLine[]): number {
  return PAD_Y * 2 + lines.length * LINE_HEIGHT;
}

/** breakdown entries sorted by count desc, then label asc (stable, deterministic). */
function sortedBreakdown(breakdown: Record<string, number>): [string, number][] {
  return Object.entries(breakdown).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
}

export function buildPrismaDiagramLayout(counts: DiagramCountRow[]): PrismaDiagramLayout {
  const byKey = new Map(counts.map((c) => [c.key, c]));
  const valueOf = (key: string) => byKey.get(key)?.value ?? 0;
  const breakdownOf = (key: string): [string, number][] => {
    const raw = byKey.get(key)?.breakdown;
    return raw ? sortedBreakdown(raw) : [];
  };

  const sources = breakdownOf("records_identified");
  const identifiedLines: DiagramLine[] = [
    { text: "Records identified from:", bold: true },
    ...(sources.length > 0
      ? sources.map(([name, n]) => ({ text: countLine(name, n), indent: true }))
      : [{ text: countLine("Databases", valueOf("records_identified")), indent: true }]),
  ];
  const removedLines: DiagramLine[] = [
    { text: "Records removed before screening:", bold: true },
    { text: countLine("Duplicate records removed", valueOf("duplicates_removed")), indent: true },
  ];

  const reasons = breakdownOf("reports_excluded");
  const reportsExcludedLines: DiagramLine[] =
    reasons.length > 0
      ? [
          { text: "Reports excluded:", bold: true },
          ...reasons.map(([label, n]) => ({ text: countLine(label, n), indent: true })),
        ]
      : [{ text: countLine("Reports excluded", valueOf("reports_excluded")) }];

  const includedLines: DiagramLine[] = [
    { text: countLine("Studies included in review", valueOf("studies_included")) },
    { text: countLine("Reports of included studies", valueOf("reports_included")) },
  ];
  if (byKey.has("studies_in_quantitative_synthesis")) {
    includedLines.push({
      text: countLine(
        "Studies in quantitative synthesis",
        valueOf("studies_in_quantitative_synthesis"),
      ),
    });
  }

  const rows: { left: DiagramLine[]; right: DiagramLine[] | null }[] = [
    { left: identifiedLines, right: removedLines },
    {
      left: [{ text: countLine("Records screened", valueOf("records_screened")) }],
      right: [{ text: countLine("Records excluded", valueOf("records_excluded_ta")) }],
    },
    {
      left: [{ text: countLine("Reports sought for retrieval", valueOf("reports_sought")) }],
      right: [{ text: countLine("Reports not retrieved", valueOf("reports_not_retrieved")) }],
    },
    {
      left: [{ text: countLine("Reports assessed for eligibility", valueOf("reports_assessed")) }],
      right: reportsExcludedLines,
    },
    { left: includedLines, right: null },
  ];

  const barX = MARGIN;
  const leftX = MARGIN + BAR_WIDTH + BAR_GAP;
  const rightX = leftX + BOX_WIDTH + COL_GAP;
  const width = rightX + BOX_WIDTH + MARGIN;

  const boxes: DiagramBox[] = [];
  const arrows: DiagramArrow[] = [];
  const rowSpans: { top: number; bottom: number }[] = [];

  let y = MARGIN;
  let previousLeft: DiagramBox | null = null;
  for (const row of rows) {
    const leftLines = wrapLines(row.left);
    const left: DiagramBox = {
      x: leftX,
      y,
      width: BOX_WIDTH,
      height: boxHeight(leftLines),
      lines: leftLines,
    };
    boxes.push(left);

    let rowHeight = left.height;
    if (row.right) {
      const rightLines = wrapLines(row.right);
      const right: DiagramBox = {
        x: rightX,
        y,
        width: BOX_WIDTH,
        height: boxHeight(rightLines),
        lines: rightLines,
      };
      boxes.push(right);
      rowHeight = Math.max(rowHeight, right.height);
      const arrowY = y + Math.min(left.height, right.height) / 2;
      arrows.push({ x1: leftX + BOX_WIDTH, y1: arrowY, x2: rightX - 2, y2: arrowY });
    }

    if (previousLeft) {
      const cx = leftX + BOX_WIDTH / 2;
      arrows.push({ x1: cx, y1: previousLeft.y + previousLeft.height, x2: cx, y2: y - 2 });
    }

    rowSpans.push({ top: y, bottom: y + rowHeight });
    previousLeft = left;
    y += rowHeight + ROW_GAP;
  }

  const height = y - ROW_GAP + MARGIN;

  const barFor = (label: string, from: number, to: number): DiagramStageBar => {
    const first = rowSpans[from];
    const last = rowSpans[to];
    if (!first || !last) throw new Error(`stage bar rows out of range: ${from}-${to}`);
    return { x: barX, y: first.top, width: BAR_WIDTH, height: last.bottom - first.top, label };
  };
  const bars: DiagramStageBar[] = [
    barFor("Identification", 0, 0),
    barFor("Screening", 1, 3),
    barFor("Included", 4, 4),
  ];

  return { width, height, boxes, arrows, bars };
}

export function escapeXml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

const PALETTE = {
  background: "#ffffff",
  boxFill: "#ffffff",
  boxStroke: "#64748b",
  text: "#0f172a",
  barFill: "#dbeafe",
  barText: "#1e3a8a",
  arrow: "#475569",
};

/** Render the layout as a standalone SVG document string. */
export function prismaDiagramSvg(layout: PrismaDiagramLayout): string {
  const parts: string[] = [];
  parts.push(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${layout.width} ${layout.height}" ` +
      `width="${layout.width}" height="${layout.height}" ` +
      `font-family="Helvetica, Arial, sans-serif" font-size="${FONT_SIZE}">`,
    `<title>PRISMA 2020 flow diagram</title>`,
    `<defs><marker id="pf-arrow" markerWidth="8" markerHeight="8" refX="7" refY="4" ` +
      `orient="auto" markerUnits="userSpaceOnUse">` +
      `<path d="M0,0 L8,4 L0,8 z" fill="${PALETTE.arrow}"/></marker></defs>`,
    `<rect width="${layout.width}" height="${layout.height}" fill="${PALETTE.background}"/>`,
  );

  for (const bar of layout.bars) {
    const cx = bar.x + bar.width / 2;
    const cy = bar.y + bar.height / 2;
    parts.push(
      `<rect x="${bar.x}" y="${bar.y}" width="${bar.width}" height="${bar.height}" rx="4" ` +
        `fill="${PALETTE.barFill}"/>`,
      `<text x="${cx}" y="${cy}" fill="${PALETTE.barText}" font-size="12" font-weight="600" ` +
        `text-anchor="middle" dominant-baseline="central" ` +
        `transform="rotate(-90 ${cx} ${cy})">${escapeXml(bar.label)}</text>`,
    );
  }

  for (const box of layout.boxes) {
    parts.push(
      `<rect x="${box.x}" y="${box.y}" width="${box.width}" height="${box.height}" rx="2" ` +
        `fill="${PALETTE.boxFill}" stroke="${PALETTE.boxStroke}"/>`,
    );
    box.lines.forEach((line, i) => {
      const x = box.x + PAD_X + (line.indent ? INDENT : 0);
      const textY = box.y + PAD_Y + i * LINE_HEIGHT + FONT_SIZE * 0.78;
      const weight = line.bold ? ` font-weight="600"` : "";
      parts.push(
        `<text x="${x}" y="${textY}" fill="${PALETTE.text}"${weight}>${escapeXml(line.text)}</text>`,
      );
    });
  }

  for (const arrow of layout.arrows) {
    parts.push(
      `<line x1="${arrow.x1}" y1="${arrow.y1}" x2="${arrow.x2}" y2="${arrow.y2}" ` +
        `stroke="${PALETTE.arrow}" stroke-width="1.2" marker-end="url(#pf-arrow)"/>`,
    );
  }

  parts.push(`</svg>`);
  return parts.join("");
}
