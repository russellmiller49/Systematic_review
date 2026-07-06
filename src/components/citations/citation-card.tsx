"use client";

import { useState } from "react";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

export interface CitationCardData {
  id: string;
  title: string;
  authors?: { family: string; given?: string; raw?: string }[] | null;
  year?: number | null;
  journal?: string | null;
  volume?: string | null;
  issue?: string | null;
  pages?: string | null;
  abstract?: string | null;
  doi?: string | null;
  pmid?: string | null;
  sources?: string[];
  labels?: string[];
}

export function formatAuthors(authors: CitationCardData["authors"], max = 6): string {
  if (!authors || authors.length === 0) return "—";
  const names = authors.map((a) => (a.given ? `${a.family} ${initials(a.given)}` : a.family));
  return names.length > max ? `${names.slice(0, max).join(", ")}, et al.` : names.join(", ");
}

function initials(given: string): string {
  return given
    .split(/[\s.]+/)
    .filter(Boolean)
    .map((p) => p[0]!.toUpperCase())
    .join("");
}

export function CitationCard({
  citation,
  clampAbstract = true,
  highlight,
  className,
  children,
}: {
  citation: CitationCardData;
  clampAbstract?: boolean;
  highlight?: boolean;
  className?: string;
  children?: React.ReactNode; // action bar slot
}) {
  const [expanded, setExpanded] = useState(!clampAbstract);
  const meta = [
    citation.journal,
    citation.year ? String(citation.year) : null,
    citation.volume ? `${citation.volume}${citation.issue ? `(${citation.issue})` : ""}` : null,
    citation.pages,
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <div
      className={cn(
        "rounded-lg border border-border bg-card p-5 shadow-sm",
        highlight && "ring-2 ring-ring",
        className,
      )}
    >
      <h3 className="text-base font-semibold leading-snug">{citation.title}</h3>
      <p className="mt-1 text-sm text-muted-foreground">{formatAuthors(citation.authors)}</p>
      {meta && <p className="mt-0.5 text-sm text-muted-foreground">{meta}</p>}

      <div className="mt-2 flex flex-wrap items-center gap-1.5">
        {citation.doi && (
          <a
            href={`https://doi.org/${citation.doi}`}
            target="_blank"
            rel="noreferrer"
            className="inline-flex"
          >
            <Badge variant="outline" className="hover:bg-muted">
              DOI {citation.doi}
            </Badge>
          </a>
        )}
        {citation.pmid && (
          <a
            href={`https://pubmed.ncbi.nlm.nih.gov/${citation.pmid}/`}
            target="_blank"
            rel="noreferrer"
            className="inline-flex"
          >
            <Badge variant="outline" className="hover:bg-muted">
              PMID {citation.pmid}
            </Badge>
          </a>
        )}
        {citation.sources?.map((s) => (
          <Badge key={s} variant="secondary">
            {s}
          </Badge>
        ))}
        {citation.labels?.map((l) => (
          <Badge key={l} variant="maybe">
            {l}
          </Badge>
        ))}
      </div>

      {citation.abstract ? (
        <div className="mt-3">
          <p
            className={cn(
              "whitespace-pre-line text-sm leading-relaxed text-foreground/90",
              !expanded && "line-clamp-4",
            )}
          >
            {citation.abstract}
          </p>
          {clampAbstract && citation.abstract.length > 350 && (
            <button
              type="button"
              onClick={() => setExpanded((v) => !v)}
              className="mt-1 text-xs font-medium text-primary hover:underline"
            >
              {expanded ? "Show less" : "Show full abstract"}
            </button>
          )}
        </div>
      ) : (
        <p className="mt-3 text-sm italic text-muted-foreground">No abstract available.</p>
      )}

      {children && <div className="mt-4 border-t border-border pt-4">{children}</div>}
    </div>
  );
}
