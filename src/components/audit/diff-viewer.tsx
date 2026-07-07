import { cn } from "@/lib/utils";

// Side-by-side previous/new JSON panes with a subtle red/green tint, plus the
// event's metadata below. Values are rendered exactly as the audit API returns
// them — no reshaping.

function pretty(value: unknown): string {
  return JSON.stringify(value, null, 2) ?? "null";
}

const TONES = {
  previous: {
    box: "border-exclude/25 bg-exclude-muted/30",
    divider: "border-exclude/25",
    label: "text-exclude",
  },
  next: {
    box: "border-include/25 bg-include-muted/30",
    divider: "border-include/25",
    label: "text-include",
  },
} as const;

function JsonPane({
  label,
  value,
  tone,
}: {
  label: string;
  value: unknown;
  tone: keyof typeof TONES;
}) {
  const t = TONES[tone];
  return (
    <div className={cn("min-w-0 rounded-md border", t.box)}>
      <p className={cn("border-b px-3 py-1.5 text-xs font-medium", t.divider, t.label)}>{label}</p>
      {value === null || value === undefined ? (
        <p className="px-3 py-2 text-xs italic text-muted-foreground">None</p>
      ) : (
        <pre className="max-h-72 overflow-auto px-3 py-2 font-mono text-xs leading-relaxed">
          {pretty(value)}
        </pre>
      )}
    </div>
  );
}

export function DiffViewer({
  previousValue,
  newValue,
  metadata,
}: {
  previousValue: unknown;
  newValue: unknown;
  metadata?: unknown;
}) {
  return (
    <div className="space-y-3">
      <div className="grid gap-3 sm:grid-cols-2">
        <JsonPane label="Previous value" value={previousValue} tone="previous" />
        <JsonPane label="New value" value={newValue} tone="next" />
      </div>
      {metadata !== null && metadata !== undefined && (
        <div className="min-w-0 rounded-md border border-border bg-muted/40">
          <p className="border-b border-border px-3 py-1.5 text-xs font-medium text-muted-foreground">
            Metadata
          </p>
          <pre className="max-h-72 overflow-auto px-3 py-2 font-mono text-xs leading-relaxed">
            {pretty(metadata)}
          </pre>
        </div>
      )}
    </div>
  );
}
