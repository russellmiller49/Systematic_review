// Pure formatting helpers for applying RoB AI suggestions. No I/O — unit-tested.

export interface SupportQuote {
  text: string;
  page: number | null;
}

// putJudgmentSchema.support caps at 10,000 chars. Quotes win over rationale when over
// budget (they are the transparent evidence; the rationale tail is trimmed to fit).
const MAX_SUPPORT_CHARS = 10_000;

export function quoteLine(quote: SupportQuote): string {
  return quote.page !== null ? `p. ${quote.page}: “${quote.text}”` : `“${quote.text}”`;
}

// Signaling-response note format: “quote” (p. N).
export function answerNote(quote: string | null, page: number | null): string | null {
  if (!quote) return null;
  return page !== null ? `“${quote}” (p. ${page})` : `“${quote}”`;
}

export function buildSupportText(input: { rationale: string; quotes: SupportQuote[] }): string {
  const quoteBlock = input.quotes.map(quoteLine).join("\n");
  let rationale = input.rationale.trim();
  const separator = rationale && quoteBlock ? "\n\n" : "";
  const budget = MAX_SUPPORT_CHARS - quoteBlock.length - separator.length;
  if (rationale.length > budget) rationale = rationale.slice(0, Math.max(0, budget));
  return `${rationale}${rationale && quoteBlock ? "\n\n" : ""}${quoteBlock}`.slice(
    0,
    MAX_SUPPORT_CHARS,
  );
}
