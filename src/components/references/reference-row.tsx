"use client";

import { BookMarked, Pencil, Trash2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { formatCslAuthors, type ReferenceView } from "./types";

export function ReferenceRow({
  reference,
  canManage,
  onEdit,
  onDelete,
}: {
  reference: ReferenceView;
  canManage: boolean;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const { csl } = reference;
  const meta = [
    csl["container-title"],
    reference.year !== null ? String(reference.year) : null,
    csl.volume ? `${csl.volume}${csl.issue ? `(${csl.issue})` : ""}` : null,
    csl.page,
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <div className="rounded-lg border border-border bg-card p-4 shadow-sm">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <h3 className="text-sm font-semibold leading-snug">{reference.title}</h3>
          <p className="mt-0.5 text-sm text-muted-foreground">
            {formatCslAuthors(csl.author)}
            {meta && <span> · {meta}</span>}
          </p>
          {(reference.doi || reference.pmid) && (
            <p className="mt-1 flex flex-wrap gap-x-3 text-xs">
              {reference.doi && (
                <a
                  href={`https://doi.org/${reference.doi}`}
                  target="_blank"
                  rel="noreferrer"
                  className="text-primary hover:underline"
                >
                  DOI {reference.doi}
                </a>
              )}
              {reference.pmid && (
                <a
                  href={`https://pubmed.ncbi.nlm.nih.gov/${reference.pmid}/`}
                  target="_blank"
                  rel="noreferrer"
                  className="text-primary hover:underline"
                >
                  PMID {reference.pmid}
                </a>
              )}
            </p>
          )}
          {reference.notes && (
            <p className="mt-1.5 whitespace-pre-line text-xs text-muted-foreground">
              {reference.notes}
            </p>
          )}
        </div>
        <div className="flex shrink-0 flex-col items-end gap-1.5">
          <div className="flex flex-wrap justify-end gap-1">
            {reference.citationId && (
              <Badge variant="include" title="Mirrors a screening citation in this project">
                <BookMarked className="mr-1 h-3 w-3" /> included study
              </Badge>
            )}
            {reference.tags
              .filter((t) => t !== "included-study" || !reference.citationId)
              .map((tag) => (
                <Badge key={tag} variant="secondary">
                  {tag}
                </Badge>
              ))}
          </div>
          {canManage && (
            <div className="flex items-center gap-1">
              <Button variant="ghost" size="sm" className="h-7" onClick={onEdit}>
                <Pencil /> Edit
              </Button>
              <Button
                variant="ghost"
                size="sm"
                className="h-7 text-destructive hover:text-destructive"
                onClick={onDelete}
              >
                <Trash2 /> Delete
              </Button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
