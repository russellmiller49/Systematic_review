"use client";

// Public entry point for the pdf.js evidence viewer. The heavy implementation is
// dynamic-imported client-only; an error boundary guards the whole pipeline with
// the plain <iframe> viewer as fallback — the viewer must never make evidence
// LESS accessible than the browser's built-in one.

import dynamic from "next/dynamic";
import { Skeleton } from "@/components/ui/misc";
import { cn } from "@/lib/utils";
import { PdfViewerErrorBoundary } from "./error-boundary";

export interface EvidenceTarget {
  fileId: string;
  page?: number | null;
  quote?: string | null;
}

const PdfViewerImpl = dynamic(() => import("./pdf-viewer-impl").then((m) => m.PdfViewerImpl), {
  ssr: false,
  loading: () => <Skeleton className="h-full w-full" />,
});

export function PdfEvidenceViewer({
  target,
  heightClass = "h-[65vh]",
}: {
  target: EvidenceTarget;
  heightClass?: string;
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
        <PdfViewerImpl target={target} />
      </div>
    </PdfViewerErrorBoundary>
  );
}
