"use client";

// pdf.js evidence viewer implementation (all pdfjs-dist imports live here; the
// public wrapper dynamic-imports this module with ssr:false).
//
// Pipeline: fetch /api/files/{fileId} (same-origin, credentialed) -> getDocument
// -> single-page canvas render + TextLayer overlay; adjacent pages render lazily
// as the user navigates — never all pages of a large PDF eagerly. Quote targets
// are located via the shared matcher (@/lib/quote-match) searching the hint page,
// then ±1, then all remaining pages; hits become DOM-Range-derived highlight
// rects over the text layer and update the current page.
//
// Errors are surfaced by THROWING from render (fatal state) so the wrapper's
// error boundary can fall back to the plain <iframe> viewer.

import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from "react";
import { Anchor, ChevronLeft, ChevronRight, TextCursor, ZoomIn, ZoomOut } from "lucide-react";
import { getDocument, GlobalWorkerOptions, TextLayer } from "pdfjs-dist";
import type { PDFDocumentLoadingTask, PDFDocumentProxy, PDFPageProxy, RenderTask } from "pdfjs-dist";
import { toast } from "sonner";
import { matchQuote, normalizeWithMap, type NormalizedText } from "@/lib/quote-match";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton, Spinner } from "@/components/ui/misc";
import type { EvidenceSelection, EvidenceTarget } from "./pdf-evidence-viewer";

// Webpack (next dev/build) resolves this to an emitted asset URL.
GlobalWorkerOptions.workerSrc = new URL(
  "pdfjs-dist/build/pdf.worker.min.mjs",
  import.meta.url,
).toString();

type TextContent = Awaited<ReturnType<PDFPageProxy["getTextContent"]>>;

const MIN_SCALE = 0.75;
const MAX_SCALE = 2.5;
const SCALE_STEP = 0.25;

// Minimal, scoped subset of pdf.js v6's text-layer CSS (pdf_viewer.css). The
// TextLayer positions spans via the --scale-factor/--user-unit custom properties
// set inline on each page wrapper.
const TEXT_LAYER_CSS = `
.pdfev-page {
  --scale-factor: 1;
  --user-unit: 1;
  --total-scale-factor: calc(var(--scale-factor) * var(--user-unit));
  --scale-round-x: 1px;
  --scale-round-y: 1px;
  position: relative;
}
.pdfev-page [data-main-rotation="90"] { transform: rotate(90deg) translateY(-100%); }
.pdfev-page [data-main-rotation="180"] { transform: rotate(180deg) translate(-100%, -100%); }
.pdfev-page [data-main-rotation="270"] { transform: rotate(270deg) translateX(-100%); }
.pdfev-page .textLayer {
  position: absolute;
  text-align: initial;
  inset: 0;
  overflow: clip;
  opacity: 1;
  line-height: 1;
  letter-spacing: normal;
  word-spacing: normal;
  text-size-adjust: none;
  forced-color-adjust: none;
  transform-origin: 0 0;
  caret-color: CanvasText;
  z-index: 1;
  --min-font-size: 1;
  --text-scale-factor: calc(var(--total-scale-factor) * var(--min-font-size));
  --min-font-size-inv: calc(1 / var(--min-font-size));
}
.pdfev-page .textLayer :is(span, br) {
  color: transparent;
  position: absolute;
  white-space: pre;
  cursor: text;
  transform-origin: 0% 0%;
}
.pdfev-page .textLayer > :not(.markedContent),
.pdfev-page .textLayer .markedContent span:not(.markedContent) {
  z-index: 1;
  --font-height: 0;
  font-size: calc(var(--text-scale-factor) * var(--font-height));
  --scale-x: 1;
  --rotate: 0deg;
  transform: rotate(var(--rotate)) scaleX(var(--scale-x)) scale(var(--min-font-size-inv));
}
.pdfev-page .textLayer .markedContent { display: contents; }
.pdfev-page .textLayer ::selection { background: rgb(0 0 255 / 0.25); color: transparent; }
`;

// --- Page text extraction (shared by the matcher and the highlighter) ---------

interface PageTextData {
  textContent: TextContent;
  // Raw-text start offset / length per text item, index-aligned with the
  // TextLayer's textDivs (one entry per item with a defined `str`; hasEOL items
  // contribute one extra "\n" raw char that belongs to no item).
  itemStarts: number[];
  itemLens: number[];
  rawLength: number;
  norm: NormalizedText;
}

async function loadPageText(doc: PDFDocumentProxy, pageNumber: number): Promise<PageTextData> {
  const page = await doc.getPage(pageNumber);
  const textContent = await page.getTextContent();
  const parts: string[] = [];
  const itemStarts: number[] = [];
  const itemLens: number[] = [];
  let len = 0;
  for (const item of textContent.items) {
    if (!("str" in item)) continue; // marked content: no text div, no chars
    itemStarts.push(len);
    itemLens.push(item.str.length);
    parts.push(item.str);
    len += item.str.length;
    if (item.hasEOL) {
      parts.push("\n");
      len += 1;
    }
  }
  return { textContent, itemStarts, itemLens, rawLength: len, norm: normalizeWithMap(parts.join("")) };
}

// First normalized index whose source raw index is >= rawIdx (norm.map is
// nondecreasing by construction). Used to turn raw selection offsets into
// normalized-text offsets for anchors.
function lowerBoundMap(map: number[], rawIdx: number): number {
  let lo = 0;
  let hi = map.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if ((map[mid] as number) < rawIdx) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

// Raw index -> (text item, offset in item.str). Indices landing on the "\n"
// fillers (or empty items) resolve to null; callers scan in `dir` for the
// nearest real character (match endpoints are non-whitespace, so this is only
// a defensive path).
function locateExact(d: PageTextData, rawIdx: number): { item: number; offset: number } | null {
  let lo = 0;
  let hi = d.itemStarts.length - 1;
  let ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if ((d.itemStarts[mid] ?? 0) <= rawIdx) {
      ans = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  if (ans < 0) return null;
  const start = d.itemStarts[ans] ?? 0;
  const itemLen = d.itemLens[ans] ?? 0;
  if (rawIdx >= start && rawIdx < start + itemLen) return { item: ans, offset: rawIdx - start };
  return null;
}

function locateChar(
  d: PageTextData,
  rawIdx: number,
  dir: 1 | -1,
): { item: number; offset: number } | null {
  for (let idx = rawIdx; idx >= 0 && idx < d.rawLength; idx += dir) {
    const hit = locateExact(d, idx);
    if (hit) return hit;
  }
  return null;
}

// Inverse of the highlight path: DOM Range endpoint -> raw page-text offset, via the
// textDivs <-> text-item alignment (textDivs[i] renders the i-th str item; offsets in
// its Text node are offsets into item.str). Returns null when the endpoint can't be
// resolved to a text-layer span (selection started on the canvas, etc.).
function rangePointToRaw(
  data: PageTextData,
  layer: TextLayer,
  container: Node,
  offset: number,
): number | null {
  let node: Node | null = container;
  let charOffset = offset;
  if (node.nodeType !== Node.TEXT_NODE) {
    // Element container: the point sits before its offset-th child; past-the-end means
    // the end of the last child (clamped below via itemLens).
    const children = node.childNodes;
    if (children.length === 0) return null;
    if (offset < children.length) {
      node = children[offset] ?? null;
      charOffset = 0;
    } else {
      node = children[children.length - 1] ?? null;
      charOffset = Number.MAX_SAFE_INTEGER;
    }
    if (node === null) return null;
  }
  const divs = layer.textDivs;
  let el: HTMLElement | null =
    node.nodeType === Node.TEXT_NODE ? node.parentElement : (node as HTMLElement);
  while (el) {
    const idx = divs.indexOf(el); // pages hold a few hundred divs — fine per mouseup
    if (idx >= 0) {
      const start = data.itemStarts[idx];
      const len = data.itemLens[idx];
      if (start === undefined || len === undefined) return null;
      return start + Math.min(charOffset, len);
    }
    el = el.parentElement;
  }
  return null;
}

// --- Match state ---------------------------------------------------------------

type MatchState =
  | { status: "searching" }
  | { status: "found"; quality: "exact" | "fuzzy"; page: number; rawStart: number; rawEnd: number }
  | { status: "page-only" }
  | { status: "none" };

function MatchChip({ state }: { state: MatchState | null }) {
  if (!state) return null; // no quote -> hidden
  if (state.status === "searching") {
    return (
      <Badge variant="muted" className="gap-1">
        <Spinner className="h-3 w-3" /> Locating quote…
      </Badge>
    );
  }
  if (state.status === "found") {
    return state.quality === "exact" ? (
      <Badge variant="include">Quote highlighted</Badge>
    ) : (
      <Badge variant="maybe">Approximate match</Badge>
    );
  }
  return (
    <Badge variant="muted">
      {state.status === "page-only" ? "Page only — quote not located" : "Quote not located"}
    </Badge>
  );
}

// --- Viewer --------------------------------------------------------------------

export function PdfViewerImpl({
  target,
  selectable = false,
  onSelectEvidence,
}: {
  target: EvidenceTarget;
  selectable?: boolean;
  onSelectEvidence?: (selection: EvidenceSelection) => void;
}) {
  const [doc, setDoc] = useState<PDFDocumentProxy | null>(null);
  const [numPages, setNumPages] = useState(0);
  const [pageNum, setPageNum] = useState(1);
  const [scale, setScale] = useState(1);
  const [match, setMatch] = useState<MatchState | null>(null);
  const [fatal, setFatal] = useState<Error | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);

  // A stored anchor's page beats the plain pageNumber as the navigation/matching hint
  // (the anchor was located against the server's stored text for this exact file).
  const hintPage = target.anchor?.page ?? target.page ?? null;
  const anchored = target.anchor != null && target.anchor.matchQuality !== "page-only";

  // Surface async failures to the wrapping error boundary (-> iframe fallback).
  if (fatal) throw fatal;

  const onFatal = useCallback((err: Error) => setFatal(err), []);

  // Load the document. StrictMode-safe: the cleanup aborts the fetch and
  // destroys the loading task (which also destroys the PDFDocumentProxy).
  useEffect(() => {
    let cancelled = false;
    let task: PDFDocumentLoadingTask | null = null;
    const ac = new AbortController();
    setDoc(null);
    setNumPages(0);
    setMatch(null);
    (async () => {
      const res = await fetch(`/api/files/${target.fileId}`, {
        credentials: "same-origin",
        signal: ac.signal,
      });
      if (!res.ok) throw new Error(`Failed to load PDF (${res.status})`);
      const data = await res.arrayBuffer();
      if (cancelled) return;
      task = getDocument({ data });
      const pdf = await task.promise;
      if (cancelled) return;
      setDoc(pdf);
      setNumPages(pdf.numPages);
      const hint = hintPage;
      setPageNum(hint !== null && hint >= 1 && hint <= pdf.numPages ? hint : 1);
    })().catch((err: unknown) => {
      if (cancelled || (err instanceof DOMException && err.name === "AbortError")) return;
      setFatal(err instanceof Error ? err : new Error(String(err)));
    });
    return () => {
      cancelled = true;
      ac.abort();
      task?.destroy().catch(() => undefined);
    };
    // Deps intentionally exclude the page hint/quote: they only seed the initial
    // page — a changed quote must not re-download the document.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [target.fileId]);

  // Per-document page-text cache shared by the matcher and the page renderer.
  const getPageText = useMemo(() => {
    if (!doc) return null;
    const cache = new Map<number, Promise<PageTextData>>();
    return (p: number): Promise<PageTextData> => {
      let entry = cache.get(p);
      if (!entry) {
        entry = loadPageText(doc, p);
        cache.set(p, entry);
      }
      return entry;
    };
  }, [doc]);

  // Locate the quote: hint page, hint±1, then all remaining pages ascending
  // (matchQuote is called per page; a "page-only" per-page result is a miss).
  useEffect(() => {
    if (!doc || !getPageText) return;
    const quote = target.quote ?? null;
    if (!quote || quote.trim() === "") {
      setMatch(null);
      return;
    }
    let cancelled = false;
    setMatch({ status: "searching" });
    const total = doc.numPages;
    const rawHint = hintPage;
    const hint = rawHint !== null && rawHint >= 1 && rawHint <= total ? rawHint : null;
    const order: number[] = [];
    if (hint !== null) {
      order.push(hint);
      if (hint - 1 >= 1) order.push(hint - 1);
      if (hint + 1 <= total) order.push(hint + 1);
    }
    for (let p = 1; p <= total; p++) if (!order.includes(p)) order.push(p);
    (async () => {
      for (const p of order) {
        const data = await getPageText(p);
        if (cancelled) return;
        const m = matchQuote([{ page: p, text: data.norm.text }], quote, p);
        if (m.quality === "exact" || m.quality === "fuzzy") {
          const rawStart = data.norm.map[m.charStart];
          const rawLast = data.norm.map[m.charEnd - 1];
          if (rawStart !== undefined && rawLast !== undefined) {
            setMatch({ status: "found", quality: m.quality, page: p, rawStart, rawEnd: rawLast + 1 });
            setPageNum(p);
            return;
          }
        }
      }
      if (!cancelled) setMatch({ status: hint !== null ? "page-only" : "none" });
    })().catch(() => {
      // Text extraction failed on some page — degrade to a page-only/none chip.
      if (!cancelled) setMatch({ status: hint !== null ? "page-only" : "none" });
    });
    return () => {
      cancelled = true;
    };
  }, [doc, getPageText, target.quote, hintPage]);

  // Fresh page -> start at its top (the highlight scroll then refines within it).
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: 0, left: 0 });
  }, [pageNum]);

  const highlight = match !== null && match.status === "found" && match.page === pageNum ? match : null;

  return (
    <div className="flex h-full w-full flex-col overflow-hidden rounded-md border border-border bg-muted/20">
      <style>{TEXT_LAYER_CSS}</style>
      <div className="flex flex-wrap items-center gap-1 border-b border-border bg-muted/40 px-2 py-1.5">
        <Button
          variant="ghost"
          size="icon"
          className="h-7 w-7"
          aria-label="Previous page"
          disabled={!doc || pageNum <= 1}
          onClick={() => setPageNum((p) => Math.max(1, p - 1))}
        >
          <ChevronLeft />
        </Button>
        <span className="min-w-14 text-center text-xs tabular-nums text-muted-foreground">
          {doc ? `${pageNum} / ${numPages}` : "— / —"}
        </span>
        <Button
          variant="ghost"
          size="icon"
          className="h-7 w-7"
          aria-label="Next page"
          disabled={!doc || pageNum >= numPages}
          onClick={() => setPageNum((p) => Math.min(numPages, p + 1))}
        >
          <ChevronRight />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          className="ml-2 h-7 w-7"
          aria-label="Zoom out"
          disabled={!doc || scale <= MIN_SCALE}
          onClick={() => setScale((s) => Math.max(MIN_SCALE, Math.round((s - SCALE_STEP) * 100) / 100))}
        >
          <ZoomOut />
        </Button>
        <span className="min-w-10 text-center text-xs tabular-nums text-muted-foreground">
          {Math.round(scale * 100)}%
        </span>
        <Button
          variant="ghost"
          size="icon"
          className="h-7 w-7"
          aria-label="Zoom in"
          disabled={!doc || scale >= MAX_SCALE}
          onClick={() => setScale((s) => Math.min(MAX_SCALE, Math.round((s + SCALE_STEP) * 100) / 100))}
        >
          <ZoomIn />
        </Button>
        <span className="grow" />
        {selectable && onSelectEvidence && (
          <Badge variant="secondary" className="gap-1">
            <TextCursor className="h-3 w-3" /> Select text to attach evidence
          </Badge>
        )}
        {anchored && (
          <Badge
            variant="secondary"
            className="gap-1"
            title="This evidence carries a stored anchor into the PDF's text"
          >
            <Anchor className="h-3 w-3" /> Anchored
          </Badge>
        )}
        <MatchChip state={match} />
      </div>
      <div ref={scrollRef} className="relative flex-1 overflow-auto">
        {doc && getPageText ? (
          <div className="flex min-h-full justify-center p-3">
            <PageView
              doc={doc}
              fileId={target.fileId}
              pageNumber={pageNum}
              scale={scale}
              highlight={highlight}
              getPageText={getPageText}
              scrollRef={scrollRef}
              onFatal={onFatal}
              onSelectEvidence={selectable ? onSelectEvidence : undefined}
            />
          </div>
        ) : (
          <Skeleton className="m-3 h-[calc(100%-1.5rem)]" />
        )}
      </div>
    </div>
  );
}

// --- Single page: canvas + text layer + highlight rects -------------------------

interface HighlightRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

function PageView({
  doc,
  fileId,
  pageNumber,
  scale,
  highlight,
  getPageText,
  scrollRef,
  onFatal,
  onSelectEvidence,
}: {
  doc: PDFDocumentProxy;
  fileId: string;
  pageNumber: number;
  scale: number;
  highlight: { rawStart: number; rawEnd: number } | null;
  getPageText: (p: number) => Promise<PageTextData>;
  scrollRef: RefObject<HTMLDivElement | null>;
  onFatal: (err: Error) => void;
  onSelectEvidence?: (selection: EvidenceSelection) => void;
}) {
  const wrapperRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const textLayerRef = useRef<HTMLDivElement | null>(null);
  // Live handles for the selection resolver (set once the page's text layer rendered).
  const pageDataRef = useRef<PageTextData | null>(null);
  const textLayerObjRef = useRef<TextLayer | null>(null);
  const [rects, setRects] = useState<HighlightRect[] | null>(null);
  const [rendering, setRendering] = useState(true);

  useEffect(() => {
    let cancelled = false;
    let renderTask: RenderTask | null = null;
    let textLayer: TextLayer | null = null;
    setRects(null);
    setRendering(true);
    pageDataRef.current = null;
    textLayerObjRef.current = null;
    (async () => {
      const data = await getPageText(pageNumber);
      const page = await doc.getPage(pageNumber);
      if (cancelled) return;
      const viewport = page.getViewport({ scale });
      const canvas = canvasRef.current;
      const layerEl = textLayerRef.current;
      const wrapper = wrapperRef.current;
      if (!canvas || !layerEl || !wrapper) return;
      // TextLayer sizes itself from these custom properties (see TEXT_LAYER_CSS).
      wrapper.style.setProperty("--scale-factor", String(viewport.scale));
      wrapper.style.setProperty("--user-unit", String(viewport.userUnit || 1));
      const dpr = window.devicePixelRatio || 1;
      canvas.width = Math.floor(viewport.width * dpr);
      canvas.height = Math.floor(viewport.height * dpr);
      canvas.style.width = `${Math.floor(viewport.width)}px`;
      canvas.style.height = `${Math.floor(viewport.height)}px`;
      const renderParams: Parameters<PDFPageProxy["render"]>[0] = { canvas, viewport };
      if (dpr !== 1) renderParams.transform = [dpr, 0, 0, dpr, 0, 0];
      renderTask = page.render(renderParams);
      layerEl.textContent = ""; // drop the previous page/scale's spans
      textLayer = new TextLayer({
        textContentSource: data.textContent,
        container: layerEl,
        viewport,
      });
      await Promise.all([renderTask.promise, textLayer.render()]);
      if (cancelled) return;
      pageDataRef.current = data;
      textLayerObjRef.current = textLayer;
      setRendering(false);
      if (highlight && wrapperRef.current) {
        // Measure synchronously: getClientRects() forces layout, so the spans'
        // geometry is final without waiting for a paint frame. (Deliberately NOT
        // requestAnimationFrame — it never fires while the document is hidden, so a
        // dialog opened in a background tab would never get its highlight.)
        applyHighlight(data, textLayer, wrapperRef.current, highlight, scrollRef.current, setRects);
      }
    })().catch((err: unknown) => {
      // Cancellation rejections (RenderingCancelledException/AbortException)
      // only arrive after cleanup set the flag.
      if (cancelled) return;
      setRendering(false);
      onFatal(err instanceof Error ? err : new Error(String(err)));
    });
    return () => {
      cancelled = true;
      renderTask?.cancel();
      textLayer?.cancel();
    };
  }, [doc, pageNumber, scale, highlight, getPageText, scrollRef, onFatal]);

  // Selection mode: resolve the finished text-layer selection to normalized-text
  // offsets (the anchor v2 contract) + the selected quote. Offsets index the SAME
  // normalized page text the matcher uses; the server re-verifies against its stored
  // copy on save, so a rendering mismatch can only downgrade quality, never corrupt.
  function handleMouseUp() {
    if (!onSelectEvidence) return;
    const data = pageDataRef.current;
    const layer = textLayerObjRef.current;
    const layerEl = textLayerRef.current;
    if (!data || !layer || !layerEl) return;
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0 || sel.isCollapsed) return;
    const range = sel.getRangeAt(0);
    if (!layerEl.contains(range.startContainer) || !layerEl.contains(range.endContainer)) return;
    const rawStart = rangePointToRaw(data, layer, range.startContainer, range.startOffset);
    const rawEnd = rangePointToRaw(data, layer, range.endContainer, range.endOffset);
    if (rawStart === null || rawEnd === null || rawEnd <= rawStart) return;
    // Raw -> normalized offsets, trimming whitespace the drag swept in at the edges.
    let charStart = lowerBoundMap(data.norm.map, rawStart);
    let charEnd = lowerBoundMap(data.norm.map, rawEnd);
    const text = data.norm.text;
    while (charStart < charEnd && text[charStart] === " ") charStart++;
    while (charEnd > charStart && text[charEnd - 1] === " ") charEnd--;
    if (charEnd <= charStart) return;
    const quote = text.slice(charStart, charEnd);
    if (quote.length > 8000) {
      // sourceQuote schema cap — tell the user instead of silently dropping the drag.
      toast.error("Selection is too long to attach as evidence (8,000 character limit)");
      return;
    }
    onSelectEvidence({
      quote,
      page: pageNumber,
      anchor: { v: 2, fileId, page: pageNumber, charStart, charEnd, matchQuality: "selection" },
    });
  }

  // The drag often ENDS outside the page wrapper (dialog chrome, past the page edge) —
  // a wrapper-scoped mouseup would silently drop those selections, so listen on the
  // document; handleMouseUp validates the selection lives inside the text layer.
  const handleMouseUpRef = useRef(handleMouseUp);
  handleMouseUpRef.current = handleMouseUp;
  useEffect(() => {
    if (!onSelectEvidence) return;
    const onUp = () => handleMouseUpRef.current();
    document.addEventListener("mouseup", onUp);
    return () => document.removeEventListener("mouseup", onUp);
  }, [onSelectEvidence]);

  return (
    <div ref={wrapperRef} className="pdfev-page h-fit w-fit bg-white shadow-sm">
      <canvas ref={canvasRef} className="block" />
      <div ref={textLayerRef} className="textLayer" />
      {rects?.map((r, i) => (
        <div
          key={i}
          className="pointer-events-none absolute z-[2] rounded-[2px] mix-blend-multiply"
          style={{
            left: r.left,
            top: r.top,
            width: r.width,
            height: r.height,
            backgroundColor: "rgb(250 204 21 / 0.45)",
          }}
        />
      ))}
      {rendering && (
        <div className="absolute inset-0 z-[3] flex items-center justify-center">
          <Spinner className="h-5 w-5 text-muted-foreground" />
        </div>
      )}
    </div>
  );
}

// Raw char offsets -> DOM Range over the text-layer spans -> highlight rects in
// page-wrapper coordinates, scrolling the first rect into view.
function applyHighlight(
  data: PageTextData,
  layer: TextLayer,
  wrapper: HTMLElement,
  hl: { rawStart: number; rawEnd: number },
  scroller: HTMLDivElement | null,
  setRects: (r: HighlightRect[] | null) => void,
): void {
  const divs = layer.textDivs;
  const start = locateChar(data, hl.rawStart, 1);
  const end = locateChar(data, hl.rawEnd - 1, -1);
  if (!start || !end) return;
  if (end.item < start.item || (end.item === start.item && end.offset < start.offset)) return;
  const startNode = divs[start.item]?.firstChild;
  const endNode = divs[end.item]?.firstChild;
  if (!(startNode instanceof Text) || !(endNode instanceof Text)) return;
  const range = document.createRange();
  // normalizeWithMap maps every normalized char of an astral code point back to the
  // raw index of its HIGH surrogate, so a quote ending in one (e.g. a mathematical
  // beta) resolves `end` to the pair's first code unit. Never end the Range between
  // the surrogate halves: take both code units when a low surrogate follows. (The
  // start needs no counterpart — setStart AT the high surrogate includes the pair.)
  const endCode = endNode.data.charCodeAt(end.offset);
  const nextCode = endNode.data.charCodeAt(end.offset + 1); // NaN past the end -> span 1
  const endSpan =
    endCode >= 0xd800 && endCode <= 0xdbff && nextCode >= 0xdc00 && nextCode <= 0xdfff ? 2 : 1;
  try {
    range.setStart(startNode, Math.min(start.offset, startNode.length));
    range.setEnd(endNode, Math.min(end.offset + endSpan, endNode.length));
  } catch {
    return;
  }
  const clientRects = Array.from(range.getClientRects()).filter(
    (r) => r.width > 0.5 && r.height > 0.5,
  );
  // Browsers emit both element- and text-level rects for multi-span ranges: drop
  // any rect strictly contained in a bigger one, then exact duplicates.
  const outer = clientRects.filter(
    (r, i) =>
      !clientRects.some(
        (o, j) =>
          j !== i &&
          o.left <= r.left + 1 &&
          o.top <= r.top + 1 &&
          o.right >= r.right - 1 &&
          o.bottom >= r.bottom - 1 &&
          (o.width > r.width + 1 || o.height > r.height + 1),
      ),
  );
  const seen = new Set<string>();
  const unique = outer.filter((r) => {
    const key = `${Math.round(r.left)}:${Math.round(r.top)}:${Math.round(r.width)}:${Math.round(r.height)}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  const first = unique[0];
  if (!first) return;
  const wrapperRect = wrapper.getBoundingClientRect();
  setRects(
    unique.map((r) => ({
      left: r.left - wrapperRect.left,
      top: r.top - wrapperRect.top,
      width: r.width,
      height: r.height,
    })),
  );
  if (scroller) {
    const sRect = scroller.getBoundingClientRect();
    scroller.scrollTop += first.top - sRect.top - scroller.clientHeight / 3;
    if (first.left < sRect.left || first.right > sRect.right) {
      scroller.scrollLeft += first.left - sRect.left - scroller.clientWidth / 3;
    }
  }
}
