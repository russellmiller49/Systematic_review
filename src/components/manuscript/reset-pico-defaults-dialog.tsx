"use client";

import { useState } from "react";
import { RotateCcw } from "lucide-react";
import { toast } from "sonner";
import { apiPost, ApiError } from "@/lib/api";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Alert, Spinner } from "@/components/ui/misc";

const PICO_SECTION_NAMES = [
  "Question",
  "Evidence summary",
  "Certainty of evidence",
  "Recommendation",
  "Rationale and considerations",
];

export function ResetPicoDefaultsDialog({
  projectId,
  sectionCount,
  wordCount,
  onReset,
}: {
  projectId: string;
  sectionCount: number;
  wordCount: number;
  onReset: () => void | Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [accepted, setAccepted] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function reset() {
    if (!accepted) return;
    setBusy(true);
    setError(null);
    try {
      await apiPost(`/api/projects/${projectId}/manuscript/reset-pico-defaults`, {
        confirmDataLoss: true,
      });
      await onReset();
      toast.success("Manuscript replaced with the PICO default sections");
      setOpen(false);
    } catch (err) {
      const message =
        err instanceof ApiError ? err.message : "Failed to replace the manuscript sections";
      setError(message);
      toast.error(message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (next) {
          setAccepted(false);
          setError(null);
          setBusy(false);
        }
      }}
    >
      <DialogTrigger asChild>
        <Button variant="outline" size="sm">
          <RotateCcw /> Use PICO defaults
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Replace with PICO manuscript defaults?</DialogTitle>
          <DialogDescription>
            This legacy sub-project still has a standalone manuscript layout.
          </DialogDescription>
        </DialogHeader>

        {error && <Alert variant="error">{error}</Alert>}

        <Alert variant="error">
          <p className="font-semibold">Manuscript data will be permanently deleted.</p>
          <p className="mt-1">
            All {sectionCount} current sections and their written content
            {wordCount > 0 ? ` (${wordCount.toLocaleString()} words)` : ""}, comments,
            version history, assignments, review statuses, and active edit locks will be
            removed. This cannot be undone.
          </p>
        </Alert>

        <div className="rounded-md border border-border p-4 text-sm">
          <p className="font-medium">The new manuscript will contain:</p>
          <ol className="mt-2 list-decimal space-y-1 pl-5 text-muted-foreground">
            {PICO_SECTION_NAMES.map((name) => (
              <li key={name}>{name}</li>
            ))}
          </ol>
          <p className="mt-3 text-xs text-muted-foreground">
            The review protocol, citations, screening, extraction, analysis, reference
            library, manuscript title, and citation style are not changed.
          </p>
        </div>

        <label className="flex items-start gap-2 rounded-md border border-border p-3 text-sm">
          <input
            type="checkbox"
            className="mt-0.5 h-4 w-4 accent-[var(--color-destructive)]"
            checked={accepted}
            onChange={(event) => setAccepted(event.target.checked)}
          />
          <span>I understand that the current manuscript sections and their data will be deleted.</span>
        </label>

        <DialogFooter>
          <Button variant="destructive" onClick={reset} disabled={busy || !accepted}>
            {busy ? <Spinner /> : <RotateCcw />} Replace manuscript sections
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
