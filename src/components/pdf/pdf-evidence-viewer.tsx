"use client";

// Public entry point for the pdf.js evidence viewer. The heavy implementation is
// dynamic-imported client-only; an error boundary guards the whole pipeline with
// the plain <iframe> viewer as fallback — the viewer must never make evidence
// LESS accessible than the browser's built-in one.

import dynamic from "next/dynamic";
import type { SourceAnchorV2 } from "@/types/source-anchor";
import { Skeleton } from "@/components/ui/misc";
import { cn } from "@/lib/utils";
import { PdfViewerErrorBoundary } from "./error-boundary";

export interface EvidenceTarget {
  fileId: string;
  page?: number | null;
  quote?: string | null;
  // Stored v2 anchor (already parsed client-side, e.g. via readSourceAnchor). When
  // present its page wins as the navigation/matching hint, and located/selection
  // anchors get an "Anchored" affordance in the match chip.
  anchor?: SourceAnchorV2 | null;
}

// A completed text selection inside the viewer (selection mode). quote and the
// anchor's charStart/charEnd are expressed over the NORMALIZED page text
// (normalizeForMatch) — the server re-verifies against ITS stored text on save.
export interface EvidenceSelection {
  quote: string;
  page: number;
  anchor: SourceAnchorV2;
}

const PdfViewerImpl = dynamic(() => import("./pdf-viewer-impl").then((m) => m.PdfViewerImpl), {
  ssr: false,
  loading: () => <Skeleton className="h-full w-full" />,
});

export function PdfEvidenceViewer({
  target,
  heightClass = "h-[65vh]",
  selectable = false,
  onSelectEvidence,
}: {
  target: EvidenceTarget;
  heightClass?: string;
  // Selection mode: capture text-layer selections as evidence. The <iframe> fallback
  // cannot observe selections — the affordance simply never fires there (graceful no-op).
  selectable?: boolean;
  onSelectEvidence?: (selection: EvidenceSelection) => void;
}) {
  return (
    // Keyed by file so a failure on one PDF doesn't lock the boundary for the next.
    <PdfViewerErrorBoundary
      key={target.fileId}
      fallback={
        <iframe
          src={`/api/files/${target.fileId}${target.page ? `#page=${target.page}` : ""}`}
          title="Source PDF"
          className={cn("w-full rounded-md border border-border", heightClass)}
        />
      }
    >
      <div className={cn("w-full", heightClass)}>
        <PdfViewerImpl target={target} selectable={selectable} onSelectEvidence={onSelectEvidence} />
      </div>
    </PdfViewerErrorBoundary>
  );
}
