// Tests for the quote-to-text matching library (src/lib/quote-match.ts).
// Pure unit tests — no I/O. Run: npx vitest run src/lib/quote-match.test.ts

import { describe, expect, it } from "vitest";
import { matchQuote, normalizeForMatch, normalizeWithMap, type PageText } from "./quote-match";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// Pages numbered 1..n from raw text, normalized the way real callers do it.
function mkPages(...texts: string[]): PageText[] {
  return texts.map((raw, i) => ({ page: i + 1, text: normalizeForMatch(raw) }));
}

// Deterministic OCR-ish noise: substitute every `every`-th non-space char. Spaces are
// preserved so token structure survives; "q" makes rare bigrams so the damage is real.
function mutate(s: string, every: number, sub = "q"): string {
  let seen = 0;
  let out = "";
  for (const ch of s) {
    if (ch === " ") {
      out += ch;
      continue;
    }
    seen++;
    out += seen % every === 0 ? (ch === sub ? "z" : sub) : ch;
  }
  return out;
}

// ---------------------------------------------------------------------------
// normalizeForMatch
// ---------------------------------------------------------------------------

describe("normalizeForMatch", () => {
  const cases: Array<{ name: string; raw: string; expected: string }> = [
    { name: "NFKC folds ff/fi/fl ligatures", raw: "eﬀective ﬁnal ﬂow", expected: "effective final flow" },
    { name: "NFKC folds the ffi ligature", raw: "eﬃcient", expected: "efficient" },
    { name: "NFKC folds fullwidth forms, preserving case", raw: "ＡＢｃ １２", expected: "ABc 12" },
    { name: "curly single quotes -> '", raw: "‘tis Bob’s", expected: "'tis Bob's" },
    { name: 'curly double quotes -> "', raw: "“quoted” „low‟", expected: '"quoted" "low"' },
    {
      name: "en/em/minus/non-breaking-hyphen dashes -> -",
      raw: "en–dash em—dash minus−5 nb‑hyphen",
      expected: "en-dash em-dash minus-5 nb-hyphen",
    },
    { name: "ellipsis char -> three dots", raw: "wait… done", expected: "wait... done" },
    { name: "soft hyphens stripped", raw: "soft­ware pack­age", expected: "software package" },
    { name: "de-hyphenates letter-hyphen-linebreak-letter", raw: "random-\nized", expected: "randomized" },
    { name: "de-hyphenates across CRLF plus indent", raw: "random-\r\n   ized", expected: "randomized" },
    { name: "de-hyphenates a non-breaking hyphen wrap", raw: "random‑\nized", expected: "randomized" },
    { name: "keeps hyphen when next line starts with a digit", raw: "pages 12-\n13", expected: "pages 12- 13" },
    { name: "keeps hyphen when preceded by a digit", raw: "12-\nfold", expected: "12- fold" },
    { name: "keeps hyphen with no line break", raw: "well-known", expected: "well-known" },
    { name: "keeps hyphen when spaced away from the word", raw: "well - \nknown", expected: "well - known" },
    { name: "collapses whitespace runs incl. CRLF and tabs", raw: "a\r\n\tb   c", expected: "a b c" },
    { name: "NBSP treated as whitespace", raw: "a b", expected: "a b" },
    { name: "trims", raw: "  padded  ", expected: "padded" },
    { name: "case is preserved", raw: "MiXeD Case", expected: "MiXeD Case" },
    { name: "empty string", raw: "", expected: "" },
    { name: "whitespace-only string", raw: " \n\t ", expected: "" },
  ];

  it.each(cases)("$name", ({ raw, expected }) => {
    expect(normalizeForMatch(raw)).toBe(expected);
  });
});

// ---------------------------------------------------------------------------
// normalizeWithMap
// ---------------------------------------------------------------------------

describe("normalizeWithMap", () => {
  it("identity map for plain text", () => {
    expect(normalizeWithMap("abc")).toEqual({ text: "abc", map: [0, 1, 2] });
  });

  it("normalizeForMatch is exactly normalizeWithMap(...).text", () => {
    const raw = "a “b”-\nc…";
    expect(normalizeForMatch(raw)).toBe(normalizeWithMap(raw).text);
  });

  it("NFKC expansion: every ligature output char maps to the source index", () => {
    expect(normalizeWithMap("aﬁb")).toEqual({ text: "afib", map: [0, 1, 1, 2] });
  });

  it("NFKC expansion: every ellipsis output char maps to the source index", () => {
    expect(normalizeWithMap("a…b")).toEqual({ text: "a...b", map: [0, 1, 1, 1, 2] });
  });

  it("collapsed whitespace run maps to the first whitespace char", () => {
    expect(normalizeWithMap("a \t\r\nb")).toEqual({ text: "a b", map: [0, 1, 5] });
  });

  it("soft-hyphen strip keeps true raw indices for following chars", () => {
    expect(normalizeWithMap("ran­dom")).toEqual({ text: "random", map: [0, 1, 2, 4, 5, 6] });
  });

  it("de-hyphenation keeps true raw indices for rejoined chars", () => {
    expect(normalizeWithMap("random-\nized")).toEqual({ text: "randomized", map: [0, 1, 2, 3, 4, 5, 8, 9, 10, 11] });
  });

  it("trim drops leading offsets entirely", () => {
    expect(normalizeWithMap("  a b ")).toEqual({ text: "a b", map: [2, 3, 4] });
  });

  it("curly quotes map 1:1", () => {
    expect(normalizeWithMap("“hi”")).toEqual({ text: '"hi"', map: [0, 1, 2, 3] });
  });

  it("map is total, in-range, and monotonically non-decreasing on mixed input", () => {
    const raw = "The eﬀects of random-\nized  con­trol… trials";
    const { text, map } = normalizeWithMap(raw);
    expect(text).toBe("The effects of randomized control... trials");
    expect(map).toHaveLength(text.length);
    for (let i = 0; i < map.length; i++) {
      const idx = map[i] as number;
      expect(idx).toBeGreaterThanOrEqual(0);
      expect(idx).toBeLessThan(raw.length);
      if (i > 0) expect(idx).toBeGreaterThanOrEqual(map[i - 1] as number);
    }
    // unexpanded ASCII letters must map to an identical raw char
    for (let i = 0; i < text.length; i++) {
      const ch = text[i] as string;
      if (/[A-Za-z]/.test(ch) && raw[map[i] as number] !== "ﬀ") {
        expect(raw[map[i] as number]).toBe(ch);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// matchQuote — exact pass
// ---------------------------------------------------------------------------

describe("matchQuote exact pass", () => {
  const pages = mkPages(
    "Introduction. Chronic disease burden continues to rise worldwide.",
    "Methods. Patients were randomly assigned to treatment groups in a 1:1 ratio.",
    "Results. The randomized cohort demonstrated a significant reduction in mortality.",
    "Discussion. These findings align with prior work on early intervention."
  );

  it("finds the quote on the hint page with exact offsets and score 1", () => {
    const quote = "randomly assigned to treatment";
    const m = matchQuote(pages, quote, 2);
    const at = (pages[1] as PageText).text.indexOf(quote);
    expect(at).toBeGreaterThan(0);
    expect(m).toEqual({ quality: "exact", page: 2, charStart: at, charEnd: at + quote.length, score: 1 });
  });

  it("searches hintPage-1 before hintPage+1", () => {
    const p = mkPages("shared sentinel phrase here", "middle page text", "shared sentinel phrase here");
    expect(matchQuote(p, "shared sentinel phrase", 2)).toMatchObject({ quality: "exact", page: 1 });
  });

  it("finds on hintPage+1 when absent from hint and hint-1", () => {
    const p = mkPages("alpha text", "beta text", "unique gamma content phrase");
    expect(matchQuote(p, "unique gamma content", 2)).toMatchObject({ quality: "exact", page: 3 });
  });

  it("falls back to the remaining pages after hint neighborhood", () => {
    const p = mkPages("aaa", "bbb", "ccc", "the target phrase lives here");
    expect(matchQuote(p, "target phrase lives", 1)).toMatchObject({ quality: "exact", page: 4 });
  });

  it("remaining pages are searched ascending regardless of array order", () => {
    const p: PageText[] = [
      { page: 3, text: "duplicated finding sentence" },
      { page: 1, text: "unrelated words" },
      { page: 2, text: "duplicated finding sentence" },
    ];
    expect(matchQuote(p, "duplicated finding sentence")).toMatchObject({ quality: "exact", page: 2 });
  });

  it("still matches when the hint page number does not exist", () => {
    const p = mkPages("nothing here", "the needle sentence sits here");
    expect(matchQuote(p, "needle sentence sits", 99)).toMatchObject({ quality: "exact", page: 2 });
  });

  it("matches case-insensitively with offsets into the original page text", () => {
    const p = mkPages("The RANDOMIZED Cohort was large.");
    const m = matchQuote(p, "randomized cohort", 1);
    expect(m).toMatchObject({ quality: "exact", page: 1, charStart: 4, charEnd: 4 + "randomized cohort".length });
  });

  it("multi-occurrence quote on one page -> smallest charStart", () => {
    const p = mkPages("echo alpha filler echo alpha");
    expect(matchQuote(p, "echo alpha")).toMatchObject({ quality: "exact", page: 1, charStart: 0, charEnd: 10 });
  });

  it("normalizes the quote itself (ligature, curly quote) before matching", () => {
    const p = mkPages("The efficient final effect of Bob's method.");
    expect(matchQuote(p, "eﬃcient ﬁnal", 1)).toMatchObject({ quality: "exact", page: 1 });
    expect(matchQuote(p, "Bob’s method", 1)).toMatchObject({ quality: "exact", page: 1 });
  });

  it("matches a quote spanning a de-hyphenated line wrap", () => {
    const p = mkPages("Patients were random-\nized to the intervention arm.");
    expect((p[0] as PageText).text).toContain("randomized");
    const m = matchQuote(p, "were randomized to", 1);
    expect(m).toMatchObject({ quality: "exact", page: 1 });
  });

  it("exact match wins even for quotes shorter than the fuzzy minimum", () => {
    const p = mkPages("alpha beta gamma");
    expect(matchQuote(p, "beta", 1)).toEqual({ quality: "exact", page: 1, charStart: 6, charEnd: 10, score: 1 });
  });
});

// ---------------------------------------------------------------------------
// matchQuote — degenerate quotes and hint validity
// ---------------------------------------------------------------------------

describe("matchQuote degenerate inputs", () => {
  const pages = mkPages("some content here", "more content there");

  it("empty quote with valid hint -> page-only", () => {
    expect(matchQuote(pages, "", 2)).toEqual({ quality: "page-only", page: 2 });
  });

  it("whitespace-only quote with valid hint -> page-only", () => {
    expect(matchQuote(pages, "  \n\t ", 1)).toEqual({ quality: "page-only", page: 1 });
  });

  it("empty quote without hint -> none", () => {
    expect(matchQuote(pages, "")).toEqual({ quality: "none" });
    expect(matchQuote(pages, "", null)).toEqual({ quality: "none" });
  });

  it("empty quote with a hint that is not a real page -> none", () => {
    expect(matchQuote(pages, "", 99)).toEqual({ quality: "none" });
  });

  it("no pages at all -> none", () => {
    expect(matchQuote([], "anything at all", 1)).toEqual({ quality: "none" });
  });
});

// ---------------------------------------------------------------------------
// matchQuote — fuzzy pass
// ---------------------------------------------------------------------------

const CLEAN_SENTENCE =
  "the randomized cohort demonstrated a significant reduction in mortality compared with the control arm";

function fuzzyPages(): PageText[] {
  return mkPages(
    "Introduction. Chronic obstructive pulmonary disease remains a leading cause of morbidity and mortality worldwide, with substantial burden on health systems.",
    `Results. In the intention-to-treat analysis, ${CLEAN_SENTENCE}, a finding that persisted after adjustment for baseline covariates.`,
    "Discussion. Our findings should be interpreted in light of several limitations, including the open-label design and the limited follow-up duration."
  );
}

describe("matchQuote fuzzy pass", () => {
  it("recovers a quote with ~10% OCR-ish noise on the hint page", () => {
    const pages = fuzzyPages();
    const noisy = mutate(CLEAN_SENTENCE, 10);
    expect(noisy).not.toBe(CLEAN_SENTENCE);
    const m = matchQuote(pages, noisy, 2);
    expect(m.quality).toBe("fuzzy");
    if (m.quality !== "fuzzy") return;
    expect(m.page).toBe(2);
    expect(m.score).toBeGreaterThanOrEqual(0.75);
    expect(m.score).toBeLessThanOrEqual(1);
    // the returned span must land on the true sentence
    const s0 = (pages[1] as PageText).text.indexOf(CLEAN_SENTENCE);
    const e0 = s0 + CLEAN_SENTENCE.length;
    const overlap = Math.max(0, Math.min(e0, m.charEnd) - Math.max(s0, m.charStart));
    expect(overlap).toBeGreaterThanOrEqual(0.6 * CLEAN_SENTENCE.length);
    expect(m.charStart).toBeGreaterThanOrEqual(0);
    expect(m.charEnd).toBeLessThanOrEqual((pages[1] as PageText).text.length);
  });

  it("recovers without any hint by searching all pages", () => {
    const m = matchQuote(fuzzyPages(), mutate(CLEAN_SENTENCE, 10));
    expect(m).toMatchObject({ quality: "fuzzy", page: 2 });
  });

  it("recovers heavier noise (~15-20%) via the char-level ratio refinement", () => {
    const m = matchQuote(fuzzyPages(), mutate(CLEAN_SENTENCE, 5), 2);
    expect(m.quality).toBe("fuzzy");
    if (m.quality !== "fuzzy") return;
    expect(m.page).toBe(2);
    expect(m.score).toBeGreaterThanOrEqual(0.75);
  });

  it("rejects a stopword-sharing but different quote -> page-only with valid hint", () => {
    const decoy = "the secondary analysis considered a modest elevation in latency compared with the placebo arm";
    expect(matchQuote(fuzzyPages(), decoy, 2)).toEqual({ quality: "page-only", page: 2 });
  });

  it("rejects an unrelated long quote without hint -> none", () => {
    const unrelated = "quantum entanglement of photon pairs enables violation of Bell inequalities at long distances";
    expect(matchQuote(fuzzyPages(), unrelated)).toEqual({ quality: "none" });
  });

  it("rejects heavily corrupted text (every 2nd char) -> page-only with hint", () => {
    expect(matchQuote(fuzzyPages(), mutate(CLEAN_SENTENCE, 2), 2)).toEqual({ quality: "page-only", page: 2 });
  });

  it("short quotes (<12 normalized chars) never fuzzy-match", () => {
    const pages = mkPages("hello world of text");
    const m = matchQuote(pages, "hqllo wqrld", 1); // 11 chars, mutated -> exact fails
    expect(m).toEqual({ quality: "page-only", page: 1 });
    expect(matchQuote(pages, "hqllo wqrld")).toEqual({ quality: "none" });
  });

  it("12+ char quotes are eligible for fuzzy", () => {
    const pages = mkPages("filler start hello worlds of text filler end");
    const m = matchQuote(pages, "hello worldz of texq", 1); // 20 chars, light noise
    expect(m.quality).toBe("fuzzy");
  });

  it("earliest page in search order wins on tied fuzzy scores", () => {
    const para = "alpha bravo charlie delta echo foxtrot golf hotel india juliet kilo lima";
    const pages = mkPages("zebra yankee xray words", para, "unrelated middle words entirely", para);
    const noisy = mutate(para, 10);
    // no hint: pages ascending -> page 2 beats identical page 4
    expect(matchQuote(pages, noisy)).toMatchObject({ quality: "fuzzy", page: 2 });
    // hint on page 4: page 4 is searched first and wins the tie
    expect(matchQuote(pages, noisy, 4)).toMatchObject({ quality: "fuzzy", page: 4 });
  });
});

// ---------------------------------------------------------------------------
// matchQuote — scale smoke test (perf guard, generous bound)
// ---------------------------------------------------------------------------

describe("matchQuote at document scale", () => {
  // Deterministic word soup: half shared vocabulary, half page-specific words.
  function lcg(seed: number): () => number {
    let s = seed >>> 0;
    return () => {
      s = (s * 1664525 + 1013904223) >>> 0;
      return s / 0xffffffff;
    };
  }

  const SHARED = ["the", "of", "and", "in", "with", "for", "patients", "study", "results", "treatment"];

  function makeDoc(): PageText[] {
    const pages: PageText[] = [];
    for (let p = 1; p <= 40; p++) {
      const rand = lcg(p * 7919);
      const words: string[] = [];
      for (let w = 0; w < 400; w++) {
        words.push(
          rand() < 0.5 ? (SHARED[Math.floor(rand() * SHARED.length)] as string) : `pg${p}word${Math.floor(rand() * 60)}`
        );
      }
      pages.push({ page: p, text: normalizeForMatch(words.join(" ")) });
    }
    return pages;
  }

  it("finds a long noisy quote in a 40-page document quickly", () => {
    const pages = makeDoc();
    const source = (pages[24] as PageText).text; // page 25
    const tokens = source.split(" ");
    const clean = tokens.slice(10, 310).join(" "); // ~2000 chars
    expect(clean.length).toBeGreaterThan(1500);
    const noisy = mutate(clean, 10);

    const t0 = performance.now();
    const m = matchQuote(pages, noisy, null);
    const elapsed = performance.now() - t0;

    expect(m).toMatchObject({ quality: "fuzzy", page: 25 });
    // generous bound: catches accidental O(n*m) full-page DP regressions only
    expect(elapsed).toBeLessThan(500);
  });

  it("exact long quote in a 40-page document", () => {
    const pages = makeDoc();
    const source = (pages[24] as PageText).text;
    const clean = source.split(" ").slice(10, 310).join(" ");
    const m = matchQuote(pages, clean, null);
    expect(m).toMatchObject({ quality: "exact", page: 25 });
  });
});
