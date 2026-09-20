"use client";

import type { ReactNode } from "react";
import { ChevronLeft, ChevronRight, Keyboard } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/misc";

export function ArticlePosition({
  position,
  total,
  saving,
  canNavigate,
  onNavigate,
  onHelp,
  children,
}: {
  position: number;
  total: number;
  saving: boolean;
  canNavigate: boolean;
  onNavigate: (delta: -1 | 1) => void;
  onHelp: () => void;
  children?: ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-2">
      <div className="flex items-center gap-2 text-sm">
        <span className="font-medium tabular-nums">
          Citation {position} of {total}
        </span>
        {saving && (
          <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
            <Spinner className="h-3 w-3" /> saving…
          </span>
        )}
      </div>
      <div className="flex flex-wrap items-center gap-1.5">
        {children}
        <Button
          variant="ghost"
          size="icon"
          className="h-7 w-7"
          aria-label="Previous article"
          title="Previous article (K or left arrow)"
          disabled={!canNavigate}
          onClick={() => onNavigate(-1)}
        >
          <ChevronLeft />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          className="h-7 w-7"
          aria-label="Next article"
          title="Next article (J or right arrow)"
          disabled={!canNavigate}
          onClick={() => onNavigate(1)}
        >
          <ChevronRight />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          className="h-7 w-7"
          aria-label="Keyboard shortcuts"
          title="Keyboard shortcuts (?)"
          onClick={onHelp}
        >
          <Keyboard />
        </Button>
      </div>
    </div>
  );
}
