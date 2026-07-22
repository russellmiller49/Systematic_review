// Minimal declaration for the zero-dependency `citeproc` package (citeproc-js).
// Only the surface src/server/csl/engine.ts uses.
declare module "citeproc" {
  interface CiteprocSys {
    retrieveLocale(lang: string): string;
    retrieveItem(id: string): Record<string, unknown>;
  }

  interface BibliographyMeta {
    entry_ids: string[][];
    [key: string]: unknown;
  }

  interface CitationCluster {
    citationItems: { id: string }[];
    properties: { noteIndex: number };
  }

  class Engine {
    constructor(sys: CiteprocSys, style: string, lang?: string, forceLang?: boolean);
    updateItems(ids: string[]): void;
    setOutputFormat(format: "html" | "text"): void;
    makeBibliography(): [BibliographyMeta, string[]] | false;
    previewCitationCluster(
      citation: CitationCluster,
      citationsPre: [string, number][],
      citationsPost: [string, number][],
      format: "html" | "text",
    ): string;
  }

  const CSL: { Engine: typeof Engine };
  export = CSL;
}
