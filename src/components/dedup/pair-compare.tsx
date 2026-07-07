"use client";

import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import type { DedupAuthor, DedupCitation, PairEvidence } from "./types";

type FieldState = "match" | "differ" | "neutral";

interface CompareField {
  label: string;
  a: string | null;
  b: string | null;
  state: FieldState;
  hint?: string;
  mono?: boolean;
}

function authorsOf(c: DedupCitation): DedupAuthor[] {
  return Array.isArray(c.authors) ? c.authors : [];
}

function authorText(authors: DedupAuthor[]): string | null {
  if (authors.length === 0) return null;
  return authors
    .map((a) => (a.given ? `${a.family} ${a.given}` : (a.raw ?? a.family)))
    .join(", ");
}

function compare(aVal: string | null, bVal: string | null, normalize = false): FieldState {
  if (aVal === null || bVal === null) return "neutral";
  const a = normalize ? aVal.trim().toLowerCase() : aVal;
  const b = normalize ? bVal.trim().toLowerCase() : bVal;
  return a === b ? "match" : "differ";
}

function buildFields(
  a: DedupCitation,
  b: DedupCitation,
  reasons: PairEvidence | null,
): CompareField[] {
  const aAuthors = authorText(authorsOf(a));
  const bAuthors = authorText(authorsOf(b));
  const titleState: FieldState = a.normalizedTitle === b.normalizedTitle ? "match" : "differ";
  const authorState: FieldState =
    aAuthors === null || bAuthors === null
      ? "neutral"
      : reasons !== null && reasons.authorOverlap >= 1
        ? "match"
        : compare(aAuthors, bAuthors, true);
  const yearState: FieldState =
    a.year === null || b.year === null ? "neutral" : a.year === b.year ? "match" : "differ";
  const journalState: FieldState =
    reasons?.journalMatch === true ? "match" : compare(a.journal, b.journal, true);

  return [
    {
      label: "Title",
      a: a.title,
      b: b.title,
      state: titleState,
      hint:
        titleState === "differ" && reasons !== null
          ? `${Math.round(reasons.titleSimilarity * 100)}% similar`
          : undefined,
    },
    {
      label: "Authors",
      a: aAuthors,
      b: bAuthors,
      state: authorState,
      hint:
        authorState === "differ" && reasons !== null
          ? `${Math.round(reasons.authorOverlap * 100)}% overlap`
          : undefined,
    },
    {
      label: "Year",
      a: a.year !== null ? String(a.year) : null,
      b: b.year !== null ? String(b.year) : null,
      state: yearState,
    },
    { label: "Journal", a: a.journal, b: b.journal, state: journalState },
    { label: "DOI", a: a.doi, b: b.doi, state: compare(a.doi, b.doi, true), mono: true },
    { label: "PMID", a: a.pmid, b: b.pmid, state: compare(a.pmid, b.pmid), mono: true },
  ];
}

const STATE_CLASS: Record<FieldState, string> = {
  match: "bg-include-muted",
  differ: "bg-maybe-muted",
  neutral: "",
};

// Side-by-side field comparison for a candidate duplicate pair. Matching fields get a
// green tint, differing fields amber, missing-on-either-side fields stay neutral.
// When selection props are passed, each column header carries a "keep as canonical" radio.
export function PairCompare({
  a,
  b,
  reasons,
  radioName,
  canonicalId,
  onSelectCanonical,
}: {
  a: DedupCitation;
  b: DedupCitation;
  reasons: PairEvidence | null;
  radioName?: string;
  canonicalId?: string | null;
  onSelectCanonical?: (citationId: string) => void;
}) {
  const fields = buildFields(a, b, reasons);
  const selectable = radioName !== undefined && onSelectCanonical !== undefined;

  const header = (citation: DedupCitation, side: "A" | "B") => (
    <div className="flex items-center gap-2 px-3 py-2 text-xs font-medium text-muted-foreground">
      {selectable ? (
        <label className="flex cursor-pointer items-center gap-2 text-foreground">
          <input
            type="radio"
            name={radioName}
            className="h-3.5 w-3.5 accent-primary"
            checked={canonicalId === citation.id}
            disabled={citation.status !== "ACTIVE"}
            onChange={() => onSelectCanonical(citation.id)}
          />
          Keep as canonical
        </label>
      ) : (
        <span>Citation {side}</span>
      )}
      {citation.status !== "ACTIVE" && <Badge variant="muted">{citation.status.toLowerCase()}</Badge>}
    </div>
  );

  return (
    <div className="overflow-x-auto rounded-md border border-border">
      <div className="min-w-[36rem]">
        <div className="grid grid-cols-[6.5rem_1fr_1fr] border-b border-border bg-muted/50">
          <div />
          {header(a, "A")}
          {header(b, "B")}
        </div>
        {fields.map((f) => (
          <div
            key={f.label}
            className="grid grid-cols-[6.5rem_1fr_1fr] border-b border-border text-sm last:border-b-0"
          >
            <div className="px-3 py-2 text-xs font-medium text-muted-foreground">
              {f.label}
              {f.hint && <span className="mt-0.5 block font-normal">{f.hint}</span>}
            </div>
            <div
              className={cn(
                "border-l border-border px-3 py-2",
                STATE_CLASS[f.state],
                f.mono && "font-mono text-xs",
              )}
            >
              {f.a ?? <span className="text-muted-foreground">—</span>}
            </div>
            <div
              className={cn(
                "border-l border-border px-3 py-2",
                STATE_CLASS[f.state],
                f.mono && "font-mono text-xs",
              )}
            >
              {f.b ?? <span className="text-muted-foreground">—</span>}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
