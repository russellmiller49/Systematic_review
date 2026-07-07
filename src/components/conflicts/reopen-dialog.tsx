"use client";

import { useState } from "react";
import { RotateCcw } from "lucide-react";
import { toast } from "sonner";
import { apiPost, ApiError } from "@/lib/api";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Alert, Spinner } from "@/components/ui/misc";
import { STAGE_LABELS, type ConflictRow } from "@/components/conflicts/types";

export function ReopenDialog({
  projectId,
  conflict,
  onClose,
  onDone,
}: {
  projectId: string;
  conflict: ConflictRow;
  onClose: () => void;
  onDone: () => void;
}) {
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const stageLabel = STAGE_LABELS[conflict.stage.type];

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      await apiPost(`/api/projects/${projectId}/citations/${conflict.citation.id}/reopen`, {
        stageType: conflict.stage.type,
        reason: reason.trim(),
      });
      toast.success("Citation reopened — reviewer decisions are editable again");
      onDone();
    } catch (err) {
      if (err instanceof ApiError && err.status === 403) {
        toast.error("You do not have permission to reopen citations in this project");
      } else {
        toast.error(err instanceof ApiError ? err.message : "Failed to reopen citation");
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Reopen at {stageLabel.toLowerCase()} stage</DialogTitle>
          <DialogDescription className="line-clamp-2">
            {conflict.citation.title}
          </DialogDescription>
        </DialogHeader>

        <Alert variant="warning">
          Reopening deletes this citation&apos;s settled {stageLabel.toLowerCase()} result
          (the deletion is audited) and voids the resolved conflict. Reviewer decisions
          become editable again, and conflict detection reruns on the next decision — if
          reviewers still disagree, the conflict reopens for re-adjudication.
        </Alert>

        <form onSubmit={submit} className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="reopen-reason">Reason (required)</Label>
            <Textarea
              id="reopen-reason"
              required
              minLength={3}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="Why this result needs to be revisited…"
            />
          </div>
          <DialogFooter>
            <DialogClose asChild>
              <Button variant="outline" disabled={busy}>
                Cancel
              </Button>
            </DialogClose>
            <Button
              type="submit"
              variant="destructive"
              disabled={busy || reason.trim().length < 3}
            >
              {busy ? <Spinner /> : <RotateCcw />} Reopen citation
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
