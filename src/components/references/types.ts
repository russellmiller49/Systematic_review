// Shapes returned by the references API routes — only the fields this UI consumes.

export interface CslAuthorView {
  family?: string;
  given?: string;
  literal?: string;
}

// The stored CSL-JSON item (passthrough — only the fields we render are typed).
export interface CslItemView {
  id?: string;
  type: string;
  title: string;
  author?: CslAuthorView[];
  issued?: { "date-parts"?: number[][] };
  "container-title"?: string;
  volume?: string;
  issue?: string;
  page?: string;
  DOI?: string;
  PMID?: string;
  URL?: string;
  abstract?: string;
  [key: string]: unknown;
}

export interface ReferenceView {
  id: string;
  csl: CslItemView;
  title: string;
  firstAuthor: string | null;
  year: number | null;
  doi: string | null;
  pmid: string | null;
  tags: string[];
  notes: string | null;
  citationId: string | null;
  createdAt: string;
  updatedAt: string;
  addedBy: { id: string; name: string };
}

export interface StyleOption {
  id: string;
  label: string;
  numeric: boolean;
}

export interface FormattedReference {
  referenceId: string;
  index: number;
  citeMarker: string;
  html: string;
  text: string;
}

export interface BibliographyResponse {
  styleId: string;
  numeric: boolean;
  entries: FormattedReference[];
}

export interface LookupResponse {
  csl: CslItemView;
  duplicateOfId: string | null;
}

export function formatCslAuthors(authors: CslAuthorView[] | undefined, max = 6): string {
  if (!authors || authors.length === 0) return "—";
  const names = authors.map((a) => {
    if (a.literal) return a.literal;
    const initials = (a.given ?? "")
      .split(/[\s.]+/)
      .filter(Boolean)
      .map((p) => p[0]!.toUpperCase())
      .join("");
    return initials ? `${a.family ?? ""} ${initials}`.trim() : (a.family ?? "");
  });
  return names.length > max ? `${names.slice(0, max).join(", ")}, et al.` : names.join(", ");
}

export function cslYear(csl: CslItemView): number | null {
  const parts = csl.issued?.["date-parts"];
  const year = Array.isArray(parts) && Array.isArray(parts[0]) ? parts[0][0] : null;
  return typeof year === "number" ? year : null;
}
