// BibTeX writer for reference-library exports — pure; round-trip-tested against
// parseBibtex. Citekeys are firstauthorYYYY with a/b/c suffixes on collision.

import type { CslAuthor, CslItemInput } from "../csl";

const CSL_TO_BIBTEX_TYPE: Record<string, string> = {
  "article-journal": "article",
  article: "article",
  book: "book",
  chapter: "incollection",
  "paper-conference": "inproceedings",
  report: "techreport",
  thesis: "phdthesis",
  webpage: "misc",
  dataset: "misc",
};

function escapeBibtex(value: string): string {
  return value.replace(/\\/g, "\\textbackslash{}").replace(/([&%$#_])/g, "\\$1");
}

function yearOf(item: CslItemInput): number | null {
  const issued = item.issued as { "date-parts"?: unknown } | undefined;
  const parts = issued?.["date-parts"];
  const year = Array.isArray(parts) && Array.isArray(parts[0]) ? parts[0][0] : null;
  return typeof year === "number" ? year : null;
}

function authorField(authors: CslAuthor[]): string | null {
  const names = authors
    .map((a) => {
      if (a.family) return a.given ? `${a.family}, ${a.given}` : a.family;
      if (a.literal) return `{${a.literal}}`;
      return null;
    })
    .filter((n): n is string => n !== null);
  return names.length > 0 ? names.join(" and ") : null;
}

function citekeyFor(item: CslItemInput, used: Set<string>): string {
  const authors = Array.isArray(item.author) ? (item.author as CslAuthor[]) : [];
  const surname = (authors[0]?.family ?? authors[0]?.literal ?? "reference")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "");
  const year = yearOf(item);
  const base = `${surname || "reference"}${year ?? ""}` || "reference";
  let key = base;
  let suffix = 0;
  while (used.has(key)) {
    key = `${base}${String.fromCharCode(97 + suffix)}`; // a, b, c…
    suffix += 1;
  }
  used.add(key);
  return key;
}

export function writeBibtex(items: CslItemInput[]): string {
  const used = new Set<string>();
  const entries = items.map((item) => {
    const entryType = CSL_TO_BIBTEX_TYPE[item.type] ?? "misc";
    const key = citekeyFor(item, used);
    const fields: [string, string][] = [];
    const push = (name: string, value: string | number | undefined | null, escape = true) => {
      if (value === undefined || value === null || value === "") return;
      const text = typeof value === "number" ? String(value) : escape ? escapeBibtex(value) : value;
      fields.push([name, text]);
    };

    const authors = Array.isArray(item.author) ? (item.author as CslAuthor[]) : [];
    const author = authorField(authors);
    if (author) push("author", author, false); // names already brace-protected where needed
    push("title", `{${escapeBibtex(item.title)}}`, false);
    push(
      "journal",
      typeof item["container-title"] === "string" ? item["container-title"] : undefined,
    );
    push("year", yearOf(item));
    push("volume", typeof item.volume === "string" ? item.volume : undefined);
    push("number", typeof item.issue === "string" ? item.issue : undefined);
    push(
      "pages",
      typeof item.page === "string" ? item.page.replace(/[-–—]+/, "--") : undefined,
    );
    push("doi", typeof item.DOI === "string" ? item.DOI : undefined);
    push("pmid", typeof item.PMID === "string" ? item.PMID : undefined);
    push("url", typeof item.URL === "string" ? item.URL : undefined);
    push("abstract", typeof item.abstract === "string" ? item.abstract.replace(/\s+/g, " ") : undefined);

    const body = fields.map(([name, value]) => `  ${name} = {${value}}`).join(",\n");
    return `@${entryType}{${key},\n${body}\n}`;
  });
  return entries.join("\n\n") + (entries.length > 0 ? "\n" : "");
}
