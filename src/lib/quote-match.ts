// Quote-to-text matching for evidence anchoring (src/lib/quote-match.ts).
//
// CONTRACT NOTES (binding for all consumers, notably the PDF viewer):
// - Everything here is PURE, ISOMORPHIC TypeScript with ZERO imports — it runs
//   identically in the browser (pdf.js text layer) and on the server.
// - normalizeWithMap is the primitive. `map[i]` is the raw-string index (UTF-16 code
//   unit) of the character that PRODUCED normalized char i: for a collapsed whitespace
//   run, the first whitespace char; for an NFKC expansion (ligature, ellipsis), every
//   expanded char points at the single source char.
// - Normalization: NFKC fold; curly quotes -> '/"; en/em/minus/non-breaking-hyphen
//   dashes -> "-"; ellipsis -> "..."; soft hyphens stripped; letter-hyphen-linebreak-
//   letter wraps de-hyphenated; whitespace runs collapsed to one space; trimmed.
//   Case is PRESERVED — matchQuote compares case-insensitively on its own.
// - matchQuote offsets (charStart/charEnd) index into the ALREADY-NORMALIZED page
//   text supplied by the caller. Search order: hintPage, hintPage-1, hintPage+1, then
//   remaining pages ascending. Pass 1: exact case-insensitive indexOf. Pass 2 (quotes
//   >= 12 normalized chars): token sliding window prefilter refined by a char-level
//   ratio; accept when score >= 0.75. Otherwise page-only (valid hint) or none.
// - Deterministic tie-break: earliest page in search order, then smallest charStart.

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface NormalizedText {
  text: string;
  map: number[]; // map[i] = index into raw of the char that produced normalized char i
}

export interface PageText {
  page: number;
  text: string; // ALREADY normalized by the caller (normalizeForMatch)
}

export type QuoteMatch =
  | { quality: "exact" | "fuzzy"; page: number; charStart: number; charEnd: number; score: number }
  | { quality: "page-only"; page: number }
  | { quality: "none" };

// ---------------------------------------------------------------------------
// Tuning constants
// ---------------------------------------------------------------------------

const FUZZY_MIN_QUOTE_CHARS = 12; // below this, fuzzy matching is too noisy to trust
const FUZZY_ACCEPT_SCORE = 0.75;
const WINDOW_SLACK = 0.2; // token window sized quote-token-count +/- 20%
const PREFILTER_MIN_DICE = 0.2; // permissive: prefilter only ranks, never accepts
const PER_PAGE_CANDIDATES = 4; // distinct window regions kept per page
const MAX_BIGRAM_CANDIDATES = 12; // global cap on bigram-scored regions per matchQuote
const EDGE_REFINES = 3; // global cap on edge-anchoring refinements per matchQuote
const ANCHOR_MIN_LEN = 8; // prefix/suffix anchor length bounds (chars)
const ANCHOR_MAX_LEN = 24;
const LEV_GRAY_MIN = 0.45; // bigram score floor for the expensive Levenshtein upgrade
const MAX_LEV_REFINES = 3; // global cap on banded-Levenshtein calls per matchQuote

// ---------------------------------------------------------------------------
// Normalization
// ---------------------------------------------------------------------------

// Character-level folds applied AFTER per-code-point NFKC. NFKC already folds
// ligatures/fullwidth/ellipsis/NBSP; these cover what it deliberately preserves.
function foldSpecialChar(ch: string): string {
  switch (ch) {
    case "‘": // left single curly
    case "’": // right single curly
    case "‚": // low single
    case "‛": // high-reversed single
      return "'";
    case "“": // left double curly
    case "”": // right double curly
    case "„": // low double
    case "‟": // high-reversed double
      return '"';
    case "‐": // hyphen (also NFKC image of U+2011 non-breaking hyphen)
    case "‑": // non-breaking hyphen
    case "‒": // figure dash
    case "–": // en dash
    case "—": // em dash
    case "―": // horizontal bar
    case "−": // minus sign
      return "-";
    case "…": // ellipsis (defensive: NFKC already expands it to "...")
      return "...";
    case "­": // soft hyphen: stripped
      return "";
    default:
      return ch;
  }
}

const WS_RE = /\s/;

function isWsChar(ch: string): boolean {
  const c = ch.charCodeAt(0);
  if (c === 32 || (c >= 9 && c <= 13)) return true;
  if (c < 0x80) return false;
  // U+0085 NEL is a line break but not matched by JS \s
  return c === 0x85 || WS_RE.test(ch);
}

function isLineBreakChar(ch: string): boolean {
  const c = ch.charCodeAt(0);
  return c === 10 || c === 13 || c === 11 || c === 12 || c === 0x85 || c === 0x2028 || c === 0x2029;
}

const LETTER_RE = /\p{L}/u;

function isLetterChar(ch: string): boolean {
  return LETTER_RE.test(ch);
}

export function normalizeWithMap(raw: string): NormalizedText {
  // Stage 1 — per-code-point NFKC + character folds. Applying NFKC one code point at
  // a time keeps the raw-index map exact (cross-character composition is deliberately
  // skipped; both quote and page go through the same function, so matching is
  // unaffected). Every expanded char maps back to its source code unit index.
  const chars: string[] = [];
  const rawIdx: number[] = [];
  for (let i = 0; i < raw.length; ) {
    const cp = raw.codePointAt(i) as number;
    const cpLen = cp > 0xffff ? 2 : 1;
    if (cp < 0x80) {
      // ASCII is NFKC-stable and has no fold mapping
      chars.push(raw[i] as string);
      rawIdx.push(i);
    } else {
      for (const outCp of String.fromCodePoint(cp).normalize("NFKC")) {
        const mapped = foldSpecialChar(outCp);
        for (let k = 0; k < mapped.length; k++) {
          chars.push(mapped[k] as string);
          rawIdx.push(i);
        }
      }
    }
    i += cpLen;
  }

  // Stage 2 — de-hyphenate line wraps, collapse whitespace runs, trim.
  const outChars: string[] = [];
  const outMap: number[] = [];
  let pendingWsIdx = -1; // raw idx of the first char of the current whitespace run
  const n = chars.length;
  let k = 0;
  while (k < n) {
    const ch = chars[k] as string;
    if (isWsChar(ch)) {
      if (pendingWsIdx < 0) pendingWsIdx = rawIdx[k] as number;
      k++;
      continue;
    }
    // De-hyphenation: letter "-" <ws run containing a line break> letter -> drop the
    // hyphen and the whitespace entirely. The hyphen must directly follow the letter
    // ("well - \nknown" keeps its hyphen), and digits never join ("pages 12-\n13").
    if (ch === "-" && pendingWsIdx < 0 && outChars.length > 0 && isLetterChar(outChars[outChars.length - 1] as string)) {
      let j = k + 1;
      let sawBreak = false;
      while (j < n && isWsChar(chars[j] as string)) {
        if (isLineBreakChar(chars[j] as string)) sawBreak = true;
        j++;
      }
      if (sawBreak && j < n && isLetterChar(chars[j] as string)) {
        k = j; // rejoined chars keep their true raw indices
        continue;
      }
    }
    if (pendingWsIdx >= 0 && outChars.length > 0) {
      outChars.push(" ");
      outMap.push(pendingWsIdx);
    }
    pendingWsIdx = -1; // leading whitespace (empty output) is trimmed, not emitted
    outChars.push(ch);
    outMap.push(rawIdx[k] as number);
    k++;
  }
  // Trailing whitespace: pendingWsIdx discarded — trim.

  return { text: outChars.join(""), map: outMap };
}

export function normalizeForMatch(raw: string): string {
  return normalizeWithMap(raw).text;
}

// ---------------------------------------------------------------------------
// Case folding (length-preserving, so offsets survive)
// ---------------------------------------------------------------------------

function foldCase(s: string): string {
  const lower = s.toLowerCase();
  if (lower.length === s.length) return lower; // overwhelmingly common fast path
  // Rare path: some chars (e.g. U+0130) change length when lowercased — keep those
  // unchanged so folded offsets always map 1:1 onto the input.
  const parts: string[] = [];
  for (const ch of s) {
    const lc = ch.toLowerCase();
    parts.push(lc.length === ch.length ? lc : ch);
  }
  return parts.join("");
}

// ---------------------------------------------------------------------------
// Fuzzy-match internals
// ---------------------------------------------------------------------------

interface TokenizedText {
  tokens: string[];
  starts: number[]; // char offset of each token in the source string
}

// Normalized text separates tokens with single spaces (0x20) only.
function tokenize(s: string): TokenizedText {
  const tokens: string[] = [];
  const starts: number[] = [];
  const n = s.length;
  let i = 0;
  while (i < n) {
    while (i < n && s.charCodeAt(i) === 32) i++;
    if (i >= n) break;
    const start = i;
    while (i < n && s.charCodeAt(i) !== 32) i++;
    tokens.push(s.slice(start, i));
    starts.push(start);
  }
  return { tokens, starts };
}

// Character-bigram Dice coefficient on multisets. Order-tolerant and O(n) — the cheap
// char-level ratio. Keys pack two UTF-16 code units into one number.
function bigramDice(a: string, b: string): number {
  if (a.length < 2 || b.length < 2) return a === b ? 1 : 0;
  const counts = new Map<number, number>();
  for (let i = 0; i < a.length - 1; i++) {
    const key = a.charCodeAt(i) * 0x10000 + a.charCodeAt(i + 1);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  let inter = 0;
  for (let i = 0; i < b.length - 1; i++) {
    const key = b.charCodeAt(i) * 0x10000 + b.charCodeAt(i + 1);
    const c = counts.get(key) ?? 0;
    if (c > 0) {
      counts.set(key, c - 1);
      inter++;
    }
  }
  return (2 * inter) / (a.length - 1 + (b.length - 1));
}

// Banded Levenshtein with early exit: O(len * maxDist) instead of O(len^2). Returns
// the distance, or -1 when it provably exceeds maxDist.
function boundedLevenshtein(a: string, b: string, maxDist: number): number {
  const n = a.length;
  const m = b.length;
  if (maxDist < 0 || Math.abs(n - m) > maxDist) return -1;
  if (n === 0) return m; // m <= maxDist guaranteed by the check above
  const INF = maxDist + 1;
  let prev = new Int32Array(m + 2);
  let curr = new Int32Array(m + 2);
  const initCap = Math.min(m, maxDist);
  for (let j = 0; j <= initCap; j++) prev[j] = j;
  if (initCap + 1 <= m + 1) prev[initCap + 1] = INF;
  for (let i = 1; i <= n; i++) {
    const from = Math.max(1, i - maxDist);
    const to = Math.min(m, i + maxDist);
    curr[from - 1] = i - maxDist <= 0 ? i : INF;
    let rowMin = curr[from - 1] as number;
    const ca = a.charCodeAt(i - 1);
    for (let j = from; j <= to; j++) {
      let v = (prev[j - 1] as number) + (ca === b.charCodeAt(j - 1) ? 0 : 1);
      const del = (prev[j] as number) + 1;
      if (del < v) v = del;
      const ins = (curr[j - 1] as number) + 1;
      if (ins < v) v = ins;
      if (v > INF) v = INF;
      curr[j] = v;
      if (v < rowMin) rowMin = v;
    }
    if (to + 1 <= m + 1) curr[to + 1] = INF; // band boundary for the next row's reads
    if (rowMin >= INF) return -1; // the whole band exceeded maxDist — bail out
    const tmp = prev;
    prev = curr;
    curr = tmp;
  }
  const d = prev[m] as number;
  return d <= maxDist ? d : -1;
}

interface WindowCandidate {
  orderPos: number; // position of the page in the search order (tie-break key)
  page: number;
  charStart: number;
  charEnd: number;
  // Ranking score. Starts as the prefilter token Dice; the global top candidates get
  // re-scored with char-bigram Dice and possibly a Levenshtein ratio.
  score: number;
}

function windowSpan(tok: TokenizedText, s: number, w: number): { charStart: number; charEnd: number } {
  const last = s + w - 1;
  return {
    charStart: tok.starts[s] as number,
    charEnd: (tok.starts[last] as number) + (tok.tokens[last] as string).length,
  };
}

// Slide token windows of quote-token-count (+/- WINDOW_SLACK) across one page and
// return up to PER_PAGE_CANDIDATES distinct regions ranked by token-multiset Dice.
// Char-level scoring happens globally in matchQuote, on the best regions only.
// `ids[k]` is page token k interned against the quote's tokens (-1 = not in quote),
// `needCounts[id]` the quote's multiplicity — keeps the hot loop free of Map lookups.
function pageWindowCandidates(
  tok: TokenizedText,
  ids: Int32Array,
  qTokenCount: number,
  needCounts: number[],
  orderPos: number,
  page: number
): WindowCandidate[] {
  const pn = tok.tokens.length;
  if (pn === 0) return [];

  const wMin = Math.max(1, Math.floor(qTokenCount * (1 - WINDOW_SLACK)));
  const wMax = Math.max(wMin, Math.ceil(qTokenCount * (1 + WINDOW_SLACK)));
  // Sample a handful of sizes across the range; always include the exact count.
  const sizeSet = new Set<number>();
  const step = Math.max(1, Math.ceil((wMax - wMin) / 4));
  for (let w = wMin; w < wMax; w += step) sizeSet.add(w);
  sizeSet.add(wMax);
  sizeSet.add(qTokenCount);
  const sizes = [...new Set([...sizeSet].map((w) => Math.min(w, pn)))].sort((x, y) => x - y);

  // Prefilter: token-multiset Dice vs the quote, maintained incrementally per slide.
  interface Raw {
    s: number;
    w: number;
    dice: number;
  }
  const raws: Raw[] = [];
  const used = new Int32Array(needCounts.length);
  for (const w of sizes) {
    used.fill(0);
    let overlap = 0;
    const add = (k: number) => {
      const id = ids[k] as number;
      if (id < 0) return;
      const u = (used[id] as number) + 1;
      used[id] = u;
      if (u <= (needCounts[id] as number)) overlap++;
    };
    const remove = (k: number) => {
      const id = ids[k] as number;
      if (id < 0) return;
      const u = used[id] as number;
      used[id] = u - 1;
      if (u <= (needCounts[id] as number)) overlap--;
    };
    for (let i = 0; i < w; i++) add(i);
    const denom = w + qTokenCount;
    let dice = (2 * overlap) / denom;
    if (dice >= PREFILTER_MIN_DICE) raws.push({ s: 0, w, dice });
    for (let s = 1; s + w <= pn; s++) {
      remove(s - 1);
      add(s + w - 1);
      dice = (2 * overlap) / denom;
      if (dice >= PREFILTER_MIN_DICE) raws.push({ s, w, dice });
    }
  }
  if (raws.length === 0) return [];

  // Keep the best few DISTINCT regions: overlapping windows are shifts of the same
  // spot, so suppress any window sharing >50% of its token range with a kept one.
  raws.sort((x, y) => y.dice - x.dice || x.s - y.s || x.w - y.w);
  const picked: Raw[] = [];
  for (const c of raws) {
    if (picked.length >= PER_PAGE_CANDIDATES) break;
    const clash = picked.some((p) => {
      const lo = Math.max(p.s, c.s);
      const hi = Math.min(p.s + p.w, c.s + c.w);
      return hi - lo > 0.5 * Math.min(p.w, c.w);
    });
    if (!clash) picked.push(c);
  }

  return picked.map((c) => {
    const { charStart, charEnd } = windowSpan(tok, c.s, c.w);
    return { orderPos, page, charStart, charEnd, score: c.dice };
  });
}

// Edge anchoring: the prefilter's sampled window sizes locate the right REGION but
// clip or overshoot the true span by up to WINDOW_SLACK. Pin each edge by sliding the
// quote's prefix/suffix bigrams near the window boundary — O(radius) per edge thanks
// to an incrementally maintained match count.
function bestAnchorPos(text: string, gram: string, center: number, radius: number): number {
  const k = gram.length;
  const lo = Math.max(0, center - radius);
  const hi = Math.min(text.length - k, center + radius);
  if (hi < lo || k < 2) return -1;
  const need = new Map<number, number>();
  for (let i = 0; i < k - 1; i++) {
    const key = gram.charCodeAt(i) * 0x10000 + gram.charCodeAt(i + 1);
    need.set(key, (need.get(key) ?? 0) + 1);
  }
  const have = new Map<number, number>();
  let matches = 0;
  const addAt = (i: number) => {
    const key = text.charCodeAt(i) * 0x10000 + text.charCodeAt(i + 1);
    const h = (have.get(key) ?? 0) + 1;
    have.set(key, h);
    if (h <= (need.get(key) ?? 0)) matches++;
  };
  const removeAt = (i: number) => {
    const key = text.charCodeAt(i) * 0x10000 + text.charCodeAt(i + 1);
    const h = have.get(key) ?? 0;
    have.set(key, h - 1);
    if (h <= (need.get(key) ?? 0)) matches--;
  };
  for (let i = lo; i < lo + k - 1; i++) addAt(i);
  let best = lo;
  let bestMatches = matches;
  let bestDist = Math.abs(lo - center);
  for (let pos = lo + 1; pos <= hi; pos++) {
    removeAt(pos - 1);
    addAt(pos + k - 2);
    const dist = Math.abs(pos - center);
    if (matches > bestMatches || (matches === bestMatches && dist < bestDist)) {
      best = pos;
      bestMatches = matches;
      bestDist = dist;
    }
  }
  return best;
}

function anchorEdges(pageFold: string, qFold: string, cand: WindowCandidate): WindowCandidate {
  const qLen = qFold.length;
  const k = Math.max(ANCHOR_MIN_LEN, Math.min(ANCHOR_MAX_LEN, Math.floor(qLen / 4)));
  if (qLen < k) return cand;
  const radius = Math.max(48, Math.min(512, Math.ceil(qLen * 0.25)));
  const startPos = bestAnchorPos(pageFold, qFold.slice(0, k), cand.charStart, radius);
  const endPos = bestAnchorPos(pageFold, qFold.slice(qLen - k), cand.charEnd - k, radius);
  if (startPos < 0 || endPos < 0) return cand;
  const charStart = startPos;
  const charEnd = endPos + k;
  const span = charEnd - charStart;
  if (span <= 0 || span < qLen * 0.5 || span > qLen * 2) return cand;
  const score = bigramDice(pageFold.slice(charStart, charEnd), qFold);
  if (score + 1e-12 < cand.score) return cand; // anchored edges must not cost score
  return { ...cand, charStart, charEnd, score };
}

// Deterministic ranking: higher score, then earliest page in search order, then
// smallest charStart. Negative when `a` ranks ahead of `b`.
function compareCandidates(a: WindowCandidate, b: WindowCandidate): number {
  return b.score - a.score || a.orderPos - b.orderPos || a.charStart - b.charStart;
}

// ---------------------------------------------------------------------------
// Search-order + matchQuote
// ---------------------------------------------------------------------------

function orderPages(pages: PageText[], hint: number | null): PageText[] {
  const sorted = [...pages].sort((a, b) => a.page - b.page);
  if (hint === null) return sorted;
  const pick = (num: number) => sorted.filter((p) => p.page === num);
  const head = [...pick(hint), ...pick(hint - 1), ...pick(hint + 1)];
  if (head.length === 0) return sorted;
  const headNums = new Set([hint, hint - 1, hint + 1]);
  return [...head, ...sorted.filter((p) => !headNums.has(p.page))];
}

export function matchQuote(pages: PageText[], quote: string, hintPage?: number | null): QuoteMatch {
  const hint = hintPage ?? null;
  const validHint: number | null = hint !== null && pages.some((p) => p.page === hint) ? hint : null;
  const fallback: QuoteMatch = validHint !== null ? { quality: "page-only", page: validHint } : { quality: "none" };

  const q = normalizeForMatch(quote);
  if (q.length === 0) return fallback;

  const ordered = orderPages(pages, hint);
  const qFold = foldCase(q);
  const folded = ordered.map((p) => foldCase(p.text));

  // Pass 1 — exact, case-insensitive. foldCase preserves length, so the folded index
  // is also the index into the caller's normalized page text.
  for (let i = 0; i < ordered.length; i++) {
    const idx = (folded[i] as string).indexOf(qFold);
    if (idx >= 0) {
      return {
        quality: "exact",
        page: (ordered[i] as PageText).page,
        charStart: idx,
        charEnd: idx + q.length,
        score: 1,
      };
    }
  }

  // Pass 2 — fuzzy, long quotes only.
  if (q.length >= FUZZY_MIN_QUOTE_CHARS) {
    const qTokens = tokenize(qFold).tokens;
    if (qTokens.length > 0) {
      // Intern quote tokens as dense ids so the sliding windows count with an
      // Int32Array instead of a string-keyed Map.
      const idOf = new Map<string, number>();
      const needCounts: number[] = [];
      for (const t of qTokens) {
        const id = idOf.get(t);
        if (id === undefined) {
          idOf.set(t, needCounts.length);
          needCounts.push(1);
        } else {
          needCounts[id] = (needCounts[id] as number) + 1;
        }
      }

      const toks = folded.map(tokenize);
      const candidates: WindowCandidate[] = [];
      for (let i = 0; i < ordered.length; i++) {
        const tok = toks[i] as TokenizedText;
        const ids = new Int32Array(tok.tokens.length);
        for (let k = 0; k < tok.tokens.length; k++) ids[k] = idOf.get(tok.tokens[k] as string) ?? -1;
        candidates.push(...pageWindowCandidates(tok, ids, qTokens.length, needCounts, i, (ordered[i] as PageText).page));
      }

      if (candidates.length > 0) {
        // Re-score the globally best regions with char-bigram Dice (token dice only
        // ranks), then pin the edges of the top few via prefix/suffix anchoring.
        candidates.sort(compareCandidates);
        const scored = candidates.slice(0, MAX_BIGRAM_CANDIDATES).map((c) => ({
          ...c,
          score: bigramDice((folded[c.orderPos] as string).slice(c.charStart, c.charEnd), qFold),
        }));
        scored.sort(compareCandidates);
        const refined = scored.map((c, rank) => (rank < EDGE_REFINES ? anchorEdges(folded[c.orderPos] as string, qFold, c) : c));
        refined.sort(compareCandidates);
        let best = refined[0] as WindowCandidate;

        // Bigram Dice under the accept bar can still be a genuine match (it punishes
        // scattered noise ~2x per edit) — upgrade the top gray-zone candidates with a
        // banded Levenshtein ratio, capped so unrelated pages can't blow the budget.
        if (best.score < FUZZY_ACCEPT_SCORE) {
          const gray = refined.filter((c) => c.score >= LEV_GRAY_MIN).slice(0, MAX_LEV_REFINES);
          for (const c of gray) {
            const maxLen = Math.max(c.charEnd - c.charStart, qFold.length);
            if (maxLen === 0) continue;
            const maxDist = Math.floor((1 - FUZZY_ACCEPT_SCORE) * maxLen);
            const windowText = (folded[c.orderPos] as string).slice(c.charStart, c.charEnd);
            const dist = boundedLevenshtein(windowText, qFold, maxDist);
            if (dist < 0) continue;
            const ratio = 1 - dist / maxLen;
            if (ratio > c.score) {
              const upgraded = { ...c, score: ratio };
              if (compareCandidates(upgraded, best) < 0) best = upgraded;
            }
          }
        }

        if (best.score >= FUZZY_ACCEPT_SCORE) {
          return {
            quality: "fuzzy",
            page: best.page,
            charStart: best.charStart,
            charEnd: best.charEnd,
            score: best.score,
          };
        }
      }
    }
  }

  return fallback;
}
