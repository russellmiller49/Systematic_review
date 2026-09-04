"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { Alert, Skeleton } from "@/components/ui/misc";
import type { ExclusionReasonOption, StageType } from "./types";

// Collects an optional note, then submits as soon as the reviewer chooses a reason.
// Full-text reasons also feed the PRISMA report.
export function ExcludeDialog({
  open,
  onOpenChange,
  projectId,
  stageType,
  reasons,
  defaultNote,
  onConfirm,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  projectId: string;
  stageType: StageType;
  reasons: ExclusionReasonOption[] | null;
  defaultNote: string;
  onConfirm: (exclusionReasonId: string, note: string) => void;
}) {
  const [reasonId, setReasonId] = useState("");
  const [note, setNote] = useState(defaultNote);
  const isFullText = stageType === "FULL_TEXT";
  const fieldPrefix = isFullText ? "ft" : "ta";

  // Reset the form each time the dialog opens for a new citation.
  useEffect(() => {
    if (open) {
      setReasonId("");
      setNote(defaultNote);
    }
  }, [open, defaultNote]);

  // E followed by a number is a fast two-key path; the same number also works directly
  // from the queue. Do not intercept digits while the reviewer is typing a note.
  useEffect(() => {
    if (!open || !reasons || reasons.length === 0) return;
    const listener = (event: KeyboardEvent) => {
      if (!/^[1-9]$/.test(event.key)) return;
      const target = event.target;
      if (
        target instanceof HTMLElement &&
        (target.tagName === "INPUT" ||
          target.tagName === "TEXTAREA" ||
          target.isContentEditable)
      ) {
        return;
      }
      const reason = reasons[Number(event.key) - 1];
      if (!reason) return;
      event.preventDefault();
      onConfirm(reason.id, note.trim());
    };
    window.addEventListener("keydown", listener);
    return () => window.removeEventListener("keydown", listener);
  }, [note, onConfirm, open, reasons]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            Exclude at {isFullText ? "full text" : "title & abstract"}
          </DialogTitle>
          <DialogDescription>
            {isFullText
              ? "Choose the primary reason for exclusion. It feeds the PRISMA flow diagram."
              : "Choose the primary reason subgroup so excluded citations stay organized."}
          </DialogDescription>
        </DialogHeader>

        {reasons === null ? (
          <Skeleton className="h-24" />
        ) : reasons.length === 0 ? (
          <div className="space-y-3">
            <Alert variant="warning">
              No active exclusion reasons are defined for{" "}
              {isFullText ? "full-text" : "title and abstract"} screening yet.
            </Alert>
            <Link
              href={`/projects/${projectId}/protocol`}
              className="inline-block text-sm font-medium text-primary hover:underline"
            >
              Define exclusion reasons in the protocol →
            </Link>
          </div>
        ) : (
          <div className="space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor={`${fieldPrefix}-exclusion-note`}>Note (optional)</Label>
              <Textarea
                id={`${fieldPrefix}-exclusion-note`}
                value={note}
                onChange={(e) => setNote(e.target.value)}
                maxLength={20_000}
                placeholder="Anything your co-reviewers or the adjudicator should know…"
              />
              <p className="text-xs text-muted-foreground">
                Add the note first. Choosing a reason below excludes immediately.
              </p>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor={`${fieldPrefix}-exclusion-reason`}>
                Exclusion reason subgroup
              </Label>
              <Select
                id={`${fieldPrefix}-exclusion-reason`}
                required
                value={reasonId}
                onChange={(event) => {
                  const nextReasonId = event.target.value;
                  setReasonId(nextReasonId);
                  if (nextReasonId) onConfirm(nextReasonId, note.trim());
                }}
              >
                <option value="" disabled>
                  Select a reason…
                </option>
                {reasons.map((r, index) => (
                  <option key={r.id} value={r.id}>
                    {index < 9 ? `${index + 1} · ` : ""}
                    {r.label}
                  </option>
                ))}
              </Select>
              <p className="text-xs text-muted-foreground">
                Selecting a reason or pressing 1–9 excludes immediately.
              </p>
            </div>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
                Cancel
              </Button>
            </DialogFooter>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

export function BatchExcludeDialog({
  open,
  onOpenChange,
  count,
  reasons,
  busy,
  onConfirm,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  count: number;
  reasons: ExclusionReasonOption[] | null;
  busy: boolean;
  onConfirm: (exclusionReasonId: string) => void;
}) {
  const [reasonId, setReasonId] = useState("");

  useEffect(() => {
    if (open) setReasonId("");
  }, [open]);

  return (
    <Dialog open={open} onOpenChange={busy ? undefined : onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            Exclude {count} selected article{count === 1 ? "" : "s"}
          </DialogTitle>
          <DialogDescription>
            Choose one common reason. The selected articles will be excluded immediately.
          </DialogDescription>
        </DialogHeader>

        {reasons === null ? (
          <Skeleton className="h-24" />
        ) : reasons.length === 0 ? (
          <Alert variant="warning">No active exclusion reasons are available.</Alert>
        ) : (
          <div className="space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="batch-exclusion-reason">Common exclusion reason</Label>
              <Select
                id="batch-exclusion-reason"
                required
                disabled={busy}
                value={reasonId}
                onChange={(event) => {
                  const nextReasonId = event.target.value;
                  setReasonId(nextReasonId);
                  if (nextReasonId) onConfirm(nextReasonId);
                }}
              >
                <option value="" disabled>
                  Select a reason to exclude…
                </option>
                {reasons.map((reason) => (
                  <option key={reason.id} value={reason.id}>
                    {reason.label}
                  </option>
                ))}
              </Select>
            </div>
            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                disabled={busy}
                onClick={() => onOpenChange(false)}
              >
                Cancel
              </Button>
              {busy && (
                <span className="inline-flex items-center text-sm text-muted-foreground">
                  Excluding selected articles…
                </span>
              )}
            </DialogFooter>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
