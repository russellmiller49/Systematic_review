"use client";

// GRADE certainty pill — the conventional plus/circle symbols (⊕⊕⊕⊕ … ⊕◯◯◯) with a
// color per level. Shared by the GRADE panel and the summary-of-findings table.

import { cn } from "@/lib/utils";
import { CERTAINTY_META, type GradeCertaintyId } from "./types";

export function CertaintyBadge({
  certainty,
  className,
}: {
  certainty: GradeCertaintyId;
  className?: string;
}) {
  const meta = CERTAINTY_META[certainty];
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 whitespace-nowrap rounded-full border px-2 py-0.5 text-xs font-medium",
        meta.colorClass,
        className,
      )}
    >
      <span aria-hidden="true">{meta.symbols}</span>
      <span>{meta.label}</span>
    </span>
  );
}
