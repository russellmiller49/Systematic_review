"use client";

// The amendment gate. Once screening has begun, the API rejects any protocol change made
// without an amendmentReason (422 INVALID_STATE). `useAmendmentGate().guard(title, action)`
// runs the mutation bare first; on that specific rejection it opens <AmendmentDialog />
// to collect the rationale and retries the SAME action with the amendment fields attached.
// Every other error is toasted. The action closure owns its success side effects
// (toast / close dialog / reload) so they run identically on the bare and retried paths.

import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { ApiError } from "@/lib/api";
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
import { Spinner } from "@/components/ui/misc";
import { Textarea } from "@/components/ui/textarea";
import type { AmendmentFields } from "./types";

type GuardedAction = (fields: AmendmentFields) => Promise<void>;

export function toastApiError(err: unknown, fallback: string) {
  toast.error(err instanceof ApiError ? err.message : fallback);
}

function isAmendmentRequired(err: unknown): boolean {
  return (
    err instanceof ApiError && err.code === "INVALID_STATE" && /amendment/i.test(err.message)
  );
}

export interface AmendmentGate {
  /** Run action({}); if the API demands an amendment, open the rationale dialog and retry. */
  guard: (title: string, action: GuardedAction) => Promise<void>;
  pending: { title: string; run: GuardedAction } | null;
  busy: boolean;
  submit: (reason: string, description: string) => Promise<void>;
  cancel: () => void;
}

export function useAmendmentGate(): AmendmentGate {
  const [pending, setPending] = useState<{ title: string; run: GuardedAction } | null>(null);
  const [busy, setBusy] = useState(false);

  const guard = useCallback(async (title: string, action: GuardedAction) => {
    try {
      await action({});
    } catch (err) {
      if (isAmendmentRequired(err)) {
        setPending({ title, run: action });
        return;
      }
      toastApiError(err, "Request failed");
    }
  }, []);

  const submit = useCallback(
    async (reason: string, description: string) => {
      if (!pending) return;
      setBusy(true);
      try {
        await pending.run({
          amendmentReason: reason,
          amendmentDescription: description.trim() ? description.trim() : undefined,
        });
        setPending(null);
      } catch (err) {
        toastApiError(err, "Failed to record the amendment");
      } finally {
        setBusy(false);
      }
    },
    [pending],
  );

  const cancel = useCallback(() => setPending(null), []);

  return { guard, pending, busy, submit, cancel };
}

// Rendered once per page (after the tabs, so its portal stacks above any open dialog).
export function AmendmentDialog({ gate }: { gate: AmendmentGate }) {
  const [reason, setReason] = useState("");
  const [description, setDescription] = useState("");
  const open = gate.pending !== null;

  useEffect(() => {
    if (open) {
      setReason("");
      setDescription("");
    }
  }, [open]);

  function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    void gate.submit(reason.trim(), description);
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (!o && !gate.busy) gate.cancel();
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Protocol amendment required</DialogTitle>
          <DialogDescription>
            Screening has begun, so &ldquo;{gate.pending?.title}&rdquo; must be recorded as a
            formal amendment. The change is applied immediately, a new protocol version is
            frozen, and your rationale is kept in the audit trail.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={onSubmit} className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="amendment-reason">Reason for amendment</Label>
            <Textarea
              id="amendment-reason"
              rows={3}
              required
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="Why is this change needed at this stage of the review?"
            />
            <p className="text-xs text-muted-foreground">Required — at least 3 characters.</p>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="amendment-description">Description of the change (optional)</Label>
            <Textarea
              id="amendment-description"
              rows={2}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="What exactly changed?"
            />
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={gate.cancel} disabled={gate.busy}>
              Cancel
            </Button>
            <Button type="submit" disabled={gate.busy || reason.trim().length < 3}>
              {gate.busy && <Spinner />} Record amendment &amp; save
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
