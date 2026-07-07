"use client";

// Data-driven judgment visuals. Colors come from each tool's judgmentScale JSON,
// so they are applied with inline styles rather than theme classes.

import { cn } from "@/lib/utils";
import { FALLBACK_COLOR, scaleEntryFor, type JudgmentScaleEntry } from "./types";

/** Colored pill for a judgment value (outline + dot tinted by the scale color). */
export function JudgmentBadge({
  scale,
  value,
  className,
}: {
  scale: JudgmentScaleEntry[];
  value: string | null | undefined;
  className?: string;
}) {
  if (!value) return <span className="text-xs text-muted-foreground">—</span>;
  const entry = scaleEntryFor(scale, value);
  const color = entry?.color ?? FALLBACK_COLOR;
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 whitespace-nowrap rounded-full border px-2 py-0.5 text-xs font-medium",
        className,
      )}
      style={{ borderColor: color, color }}
    >
      <span className="h-2 w-2 shrink-0 rounded-full" style={{ backgroundColor: color }} />
      {entry?.label ?? value}
    </span>
  );
}

/** Traffic-light dot for the summary table. Hollow when there is no judgment. */
export function JudgmentDot({
  scale,
  value,
  small = false,
  title,
}: {
  scale: JudgmentScaleEntry[];
  value: string | null | undefined;
  small?: boolean;
  title?: string;
}) {
  const entry = scaleEntryFor(scale, value);
  const label = value ? (entry?.label ?? value) : "No judgment";
  return (
    <span
      title={title ?? label}
      aria-label={title ?? label}
      className={cn(
        "inline-block shrink-0 rounded-full",
        small ? "h-2.5 w-2.5" : "h-3.5 w-3.5",
        !value && "border border-dashed border-muted-foreground/50",
      )}
      style={value ? { backgroundColor: entry?.color ?? FALLBACK_COLOR } : undefined}
    />
  );
}

/** Segmented judgment picker — one colored button per scale entry. */
export function JudgmentPicker({
  scale,
  value,
  onChange,
  disabled = false,
}: {
  scale: JudgmentScaleEntry[];
  value: string | null | undefined;
  onChange: (value: string) => void;
  disabled?: boolean;
}) {
  return (
    <div className="flex flex-wrap gap-1.5">
      {scale.map((entry) => {
        const selected = entry.value === value;
        const color = entry.color ?? FALLBACK_COLOR;
        return (
          <button
            key={entry.value}
            type="button"
            disabled={disabled}
            aria-pressed={selected}
            onClick={() => onChange(entry.value)}
            className={cn(
              "inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-60",
              selected
                ? "border-transparent text-white shadow-sm"
                : "border-border bg-background hover:bg-muted",
            )}
            style={selected ? { backgroundColor: color } : undefined}
          >
            {!selected && (
              <span className="h-2 w-2 shrink-0 rounded-full" style={{ backgroundColor: color }} />
            )}
            {entry.label}
          </button>
        );
      })}
    </div>
  );
}
