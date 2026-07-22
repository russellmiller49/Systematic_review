// RIS writer for reference-library exports — pure; round-trip-tested against parseRis.
// Tag choices mirror what our own RIS parser reads (TI/T2/PY/VL/IS/SP/EP/DO/UR/AB, PMID
// as AN) so a Synthesis export re-imports losslessly.

import type { CslAuthor, CslItemInput } from "../csl";

const CSL_TO_RIS_TYPE: Record<string, string> = {
  "article-journal": "JOUR",
  article: "JOUR",
  book: "BOOK",
  chapter: "CHAP",
  "paper-conference": "CONF",
  report: "RPRT",
  dataset: "DATA",
  webpage: "ELEC",
  thesis: "THES",
};

function authorLine(author: CslAuthor): string | null {
  if (author.family) return author.given ? `${author.family}, ${author.given}` : author.family;
  if (author.literal) return author.literal;
  return null;
}

function yearOf(item: CslItemInput): number | null {
  const issued = item.issued as { "date-parts"?: unknown } | undefined;
  const parts = issued?.["date-parts"];
  const year = Array.isArray(parts) && Array.isArray(parts[0]) ? parts[0][0] : null;
  return typeof year === "number" ? year : null;
}

function pagesOf(item: CslItemInput): { sp?: string; ep?: string } {
  const page = typeof item.page === "string" ? item.page : "";
  if (!page) return {};
  const [sp, ep] = page.split(/[-–—]+/).map((p) => p.trim());
  return { sp: sp || undefined, ep: ep || undefined };
}

export function writeRis(items: CslItemInput[]): string {
  const blocks = items.map((item) => {
    const lines: string[] = [];
    const push = (tag: string, value: string | number | undefined | null) => {
      if (value === undefined || value === null || value === "") return;
      lines.push(`${tag}  - ${value}`);
    };

    push("TY", CSL_TO_RIS_TYPE[item.type] ?? "GEN");
    for (const author of Array.isArray(item.author) ? (item.author as CslAuthor[]) : []) {
      push("AU", authorLine(author));
    }
    push("TI", item.title);
    push("T2", typeof item["container-title"] === "string" ? item["container-title"] : undefined);
    push("PY", yearOf(item));
    push("VL", typeof item.volume === "string" ? item.volume : undefined);
    push("IS", typeof item.issue === "string" ? item.issue : undefined);
    const { sp, ep } = pagesOf(item);
    push("SP", sp);
    push("EP", ep);
    push("DO", typeof item.DOI === "string" ? item.DOI : undefined);
    push("AN", typeof item.PMID === "string" ? item.PMID : undefined);
    push("UR", typeof item.URL === "string" ? item.URL : undefined);
    push("AB", typeof item.abstract === "string" ? item.abstract.replace(/\s+/g, " ") : undefined);
    lines.push("ER  - ");
    return lines.join("\r\n");
  });
  return blocks.join("\r\n") + (blocks.length > 0 ? "\r\n" : "");
}
