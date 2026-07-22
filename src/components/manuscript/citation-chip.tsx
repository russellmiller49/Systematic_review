"use client";

import { useContext } from "react";
import { NodeViewWrapper, type NodeViewProps } from "@tiptap/react";
import { formatCiteMarker } from "@/lib/manuscript/cite-format";
import { CiteMapContext } from "./cite-map-context";

// Inline atom chip for the `citation` node — renders the in-text marker from the shared
// cite map so screen output always matches the DOCX export.
export function CitationChip({ node }: NodeViewProps) {
  const citeMap = useContext(CiteMapContext);
  const referenceIds = Array.isArray(node.attrs.referenceIds)
    ? (node.attrs.referenceIds as string[])
    : [];
  return (
    <NodeViewWrapper as="span" className="inline">
      <span
        className="mx-0.5 rounded bg-accent px-1 py-0.5 text-xs font-medium text-accent-foreground"
        title={citeMap ? undefined : "Citation formatting loads from the reference library"}
        contentEditable={false}
      >
        {formatCiteMarker(referenceIds, citeMap)}
      </span>
    </NodeViewWrapper>
  );
}
