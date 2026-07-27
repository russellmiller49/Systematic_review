"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { X } from "lucide-react";
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

// Collects a project-defined exclusion subgroup plus an optional note before the
// screening decision is submitted. Full-text reasons also feed the PRISMA report.
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

  function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!reasonId) return;
    onConfirm(reasonId, note.trim());
  }

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
          <form onSubmit={submit} className="space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor={`${fieldPrefix}-exclusion-reason`}>
                Exclusion reason subgroup
              </Label>
              <Select
                id={`${fieldPrefix}-exclusion-reason`}
                required
                value={reasonId}
                onChange={(e) => setReasonId(e.target.value)}
              >
                <option value="" disabled>
                  Select a reason…
                </option>
                {reasons.map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.label}
                  </option>
                ))}
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor={`${fieldPrefix}-exclusion-note`}>Note (optional)</Label>
              <Textarea
                id={`${fieldPrefix}-exclusion-note`}
                value={note}
                onChange={(e) => setNote(e.target.value)}
                placeholder="Anything your co-reviewers or the adjudicator should know…"
              />
            </div>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
                Cancel
              </Button>
              <Button type="submit" variant="exclude" disabled={!reasonId}>
                <X /> Exclude citation
              </Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}
