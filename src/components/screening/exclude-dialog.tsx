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
import type { ExclusionReasonOption } from "./types";

// Full-text exclusions require a protocol exclusion reason (enforced server-side);
// this dialog collects it plus an optional note before the decision is submitted.
export function ExcludeDialog({
  open,
  onOpenChange,
  projectId,
  reasons,
  defaultNote,
  onConfirm,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  projectId: string;
  reasons: ExclusionReasonOption[] | null;
  defaultNote: string;
  onConfirm: (exclusionReasonId: string, note: string) => void;
}) {
  const [reasonId, setReasonId] = useState("");
  const [note, setNote] = useState(defaultNote);

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
          <DialogTitle>Exclude at full text</DialogTitle>
          <DialogDescription>
            Full-text exclusions require a reason — it feeds the PRISMA flow diagram.
          </DialogDescription>
        </DialogHeader>

        {reasons === null ? (
          <Skeleton className="h-24" />
        ) : reasons.length === 0 ? (
          <div className="space-y-3">
            <Alert variant="warning">
              No exclusion reasons are defined for full-text screening yet.
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
              <Label htmlFor="ft-exclusion-reason">Exclusion reason</Label>
              <Select
                id="ft-exclusion-reason"
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
              <Label htmlFor="ft-exclusion-note">Note (optional)</Label>
              <Textarea
                id="ft-exclusion-note"
                value={note}
                onChange={(e) => setNote(e.target.value)}
                placeholder="Anything your co-reviewers or the adjudicator should know…"
              />
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={() => onOpenChange(false)}>
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
