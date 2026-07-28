export type ScreeningKeywordCategoryValue = "INCLUDE" | "EXCLUDE";

export interface ScreeningKeywordRule {
  id: string;
  term: string;
  category: ScreeningKeywordCategoryValue;
}

export interface ScreeningKeywordSegment {
  text: string;
  keyword: ScreeningKeywordRule | null;
}

export function cleanScreeningKeywordTerm(value: string): string {
  return value.normalize("NFKC").trim().replace(/\s+/g, " ");
}

export function normalizeScreeningKeywordTerm(value: string): string {
  return cleanScreeningKeywordTerm(value).toLocaleLowerCase("en-US");
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Splits text into non-overlapping highlighted segments. Longer terms win when two configured
// phrases start at the same character (for example, "lung cancer" before "lung").
export function segmentScreeningKeywordText(
  text: string,
  rules: readonly ScreeningKeywordRule[],
): ScreeningKeywordSegment[] {
  if (!text || rules.length === 0) return [{ text, keyword: null }];

  const byNormalizedTerm = new Map<string, ScreeningKeywordRule>();
  for (const rule of rules) {
    const normalized = normalizeScreeningKeywordTerm(rule.term);
    if (normalized && !byNormalizedTerm.has(normalized)) byNormalizedTerm.set(normalized, rule);
  }
  const ordered = [...byNormalizedTerm.entries()].sort(
    ([termA], [termB]) => termB.length - termA.length,
  );
  if (ordered.length === 0) return [{ text, keyword: null }];

  const regex = new RegExp(ordered.map(([term]) => escapeRegex(term)).join("|"), "giu");
  const segments: ScreeningKeywordSegment[] = [];
  let cursor = 0;
  for (const match of text.matchAll(regex)) {
    const index = match.index;
    if (index === undefined) continue;
    if (index > cursor) segments.push({ text: text.slice(cursor, index), keyword: null });
    const matchedText = match[0];
    const keyword = byNormalizedTerm.get(normalizeScreeningKeywordTerm(matchedText)) ?? null;
    segments.push({ text: matchedText, keyword });
    cursor = index + matchedText.length;
  }
  if (cursor < text.length) segments.push({ text: text.slice(cursor), keyword: null });
  return segments.length > 0 ? segments : [{ text, keyword: null }];
}

export function matchingScreeningKeywords(
  texts: readonly (string | null | undefined)[],
  rules: readonly ScreeningKeywordRule[],
): ScreeningKeywordRule[] {
  const foldedText = texts
    .filter((text): text is string => typeof text === "string")
    .join("\n")
    .normalize("NFKC")
    .toLocaleLowerCase("en-US");
  return rules.filter((rule) => {
    const term = normalizeScreeningKeywordTerm(rule.term);
    return term.length > 0 && foldedText.includes(term);
  });
}
