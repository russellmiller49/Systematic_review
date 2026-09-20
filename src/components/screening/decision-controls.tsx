"use client";

import type { RefObject } from "react";
import { Check, CircleHelp, StickyNote, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import type { DecisionValue, ExclusionReasonOption } from "./types";

function KeyHint({
  label,
  onColor = false,
}: {
  label: string;
  onColor?: boolean;
}) {
  return (
    <kbd
      className={cn(
        "ml-1.5 rounded border px-1 font-mono text-[11px] leading-4",
        onColor
          ? "border-white/40 bg-white/15 text-white"
          : "border-border bg-muted text-muted-foreground",
      )}
    >
      {label}
    </kbd>
  );
}

export function DecisionControls({
  reasons,
  note,
  noteOpen,
  noteRef,
  onDecision,
  onExclude,
  onQuickExclude,
  onToggleNote,
  onNoteChange,
  onNext,
  disabled = false,
}: {
  reasons: ExclusionReasonOption[] | null;
  note: string;
  noteOpen: boolean;
  noteRef: RefObject<HTMLTextAreaElement | null>;
  onDecision: (decision: DecisionValue) => void;
  onExclude: () => void;
  onQuickExclude: (reason: ExclusionReasonOption) => void;
  onToggleNote: () => void;
  onNoteChange: (note: string) => void;
  onNext: () => void;
  disabled?: boolean;
}) {
  return (
    <fieldset disabled={disabled} className="space-y-3">
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
        <Button
          variant="include"
          size="lg"
          onClick={() => onDecision("INCLUDE")}
        >
          <Check /> Include <KeyHint label="i" onColor />
        </Button>
        <Button
          variant="exclude"
          size="lg"
          disabled={!reasons?.length}
          onClick={() => onDecision("EXCLUDE")}
        >
          <X /> Exclude <KeyHint label="e" onColor />
        </Button>
        <Button variant="maybe" size="lg" onClick={() => onDecision("MAYBE")}>
          <CircleHelp /> Maybe <KeyHint label="m" onColor />
        </Button>
      </div>

      {reasons && reasons.length > 0 && (
        <div
          role="group"
          aria-label="Quick exclusion reasons"
          className="rounded-md border border-exclude/20 bg-exclude-muted/50 p-2.5"
        >
          <div className="mb-2 flex flex-wrap items-center justify-between gap-1.5">
            <p className="text-xs font-medium text-exclude">
              Quick exclude by reason
            </p>
            <p className="text-[11px] text-muted-foreground">
              One click, or press 1–9
            </p>
          </div>
          <div className="flex flex-wrap gap-1.5">
            {reasons.slice(0, 9).map((reason, index) => (
              <Button
                key={reason.id}
                variant="outline"
                size="sm"
                className="border-exclude/30 text-exclude hover:bg-exclude-muted"
                aria-label={`Exclude: ${reason.label} (shortcut ${index + 1})`}
                onClick={() => onQuickExclude(reason)}
              >
                <X /> {reason.label} <KeyHint label={String(index + 1)} />
              </Button>
            ))}
            <Button
              variant="ghost"
              size="sm"
              className="text-muted-foreground"
              onClick={() => onExclude()}
            >
              {reasons.length > 9 ? "All reasons + note" : "Reason + note"}{" "}
              <KeyHint label="e" />
            </Button>
          </div>
        </div>
      )}

      <div className="flex flex-wrap items-center justify-between gap-2">
        <Button
          variant="outline"
          size="sm"
          aria-pressed={noteOpen}
          className={cn(noteOpen && "bg-muted")}
          onClick={() => onToggleNote()}
        >
          <StickyNote /> Note <KeyHint label="n" />
        </Button>
        <Button variant="ghost" size="sm" onClick={() => onNext()}>
          Next article <KeyHint label="j" />
        </Button>
      </div>

      {noteOpen && (
        <div className="space-y-1">
          <Textarea
            aria-label="Reviewer note"
            maxLength={20_000}
            ref={noteRef}
            value={note}
            onChange={(event) => onNoteChange(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Escape") event.currentTarget.blur();
            }}
            placeholder="Optional note, saved with your next decision on this citation…"
          />
          <p className="text-xs text-muted-foreground">
            Press Esc to leave the note and return to shortcuts.
          </p>
        </div>
      )}
    </fieldset>
  );
}
