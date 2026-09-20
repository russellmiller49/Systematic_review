"use client";

import { useEffect, useState } from "react";
import { toast } from "sonner";
import { api, apiPut, ApiError } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Alert, Skeleton, Spinner } from "@/components/ui/misc";
import type { ReviewerQuota } from "./types";

type Reviewer = {
  id: string;
  name: string;
  email: string;
  quota: ReviewerQuota | null;
};

export function QuotaAssignmentsDialog({
  endpoint,
  onSaved,
}: {
  endpoint: string;
  onSaved: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [reviewers, setReviewers] = useState<Reviewer[] | null>(null);
  const [targets, setTargets] = useState<Record<string, string>>({});
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [commonTarget, setCommonTarget] = useState("200");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setReviewers(null);
    setError(null);
    api<{ reviewers: Reviewer[] }>(endpoint)
      .then((result) => {
        if (cancelled) return;
        setReviewers(result.reviewers);
        setTargets(
          Object.fromEntries(
            result.reviewers.map((r) => [r.id, String(r.quota?.target ?? 200)]),
          ),
        );
        setSelected(
          new Set(result.reviewers.filter((r) => r.quota).map((r) => r.id)),
        );
      })
      .catch((err) => {
        if (!cancelled)
          setError(
            err instanceof ApiError
              ? err.message
              : "Unable to load reviewer quotas",
          );
      });
    return () => {
      cancelled = true;
    };
  }, [endpoint, open]);

  async function save(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    try {
      await apiPut(endpoint, {
        reviewers: [...selected].map((reviewerId) => ({
          reviewerId,
          target: Number(targets[reviewerId]),
        })),
      });
      toast.success("Shared review quotas saved");
      setOpen(false);
      onSaved();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Unable to save quotas");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="outline" size="sm">
          Shared reviewer quotas
        </Button>
      </DialogTrigger>
      <DialogContent className="max-h-[85vh] max-w-3xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Shared reviewer quotas</DialogTitle>
          <DialogDescription>
            Assign a target number of abstracts to each reviewer. Reviewers can
            choose any available abstract; each abstract accepts two independent
            reviews.
          </DialogDescription>
        </DialogHeader>
        <p className="text-sm text-muted-foreground">
          Existing completed reviews count toward the target. Each combined-pool
          abstract counts once. Set a target to 0 to pause new reviews.
          Unselected reviewers keep their current assignments.
        </p>
        {error && <Alert variant="error">{error}</Alert>}
        {!reviewers ? (
          !error && <Skeleton className="h-40" />
        ) : (
          <form onSubmit={save} className="space-y-4">
            <div className="flex flex-wrap items-end gap-2">
              <label className="space-y-1 text-sm">
                Target for selected reviewers
                <Input
                  aria-label="Target for selected reviewers"
                  type="number"
                  min={0}
                  max={1000000}
                  step={1}
                  value={commonTarget}
                  onChange={(e) => setCommonTarget(e.target.value)}
                  className="w-32"
                />
              </label>
              <Button
                variant="outline"
                onClick={() =>
                  setTargets((previous) => ({
                    ...previous,
                    ...Object.fromEntries(
                      [...selected].map((id) => [id, commonTarget]),
                    ),
                  }))
                }
              >
                Apply target
              </Button>
              <Button
                variant="ghost"
                onClick={() => setSelected(new Set(reviewers.map((r) => r.id)))}
              >
                Select all
              </Button>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b text-left">
                    <th className="p-2">Reviewer</th>
                    <th className="p-2">Target</th>
                    <th className="p-2">Completed</th>
                    <th className="p-2">Remaining</th>
                  </tr>
                </thead>
                <tbody>
                  {reviewers.map((reviewer) => (
                    <tr key={reviewer.id} className="border-b">
                      <td className="p-2">
                        <label className="flex items-center gap-2">
                          <input
                            type="checkbox"
                            checked={selected.has(reviewer.id)}
                            onChange={(e) =>
                              setSelected((previous) => {
                                const next = new Set(previous);
                                if (e.target.checked) next.add(reviewer.id);
                                else next.delete(reviewer.id);
                                return next;
                              })
                            }
                          />
                          <span>
                            {reviewer.name}
                            <span className="block text-xs text-muted-foreground">
                              {reviewer.email}
                            </span>
                          </span>
                        </label>
                      </td>
                      <td className="p-2">
                        <Input
                          aria-label={`Target for ${reviewer.name}`}
                          className="w-24"
                          type="number"
                          min={0}
                          max={1000000}
                          step={1}
                          required={selected.has(reviewer.id)}
                          disabled={!selected.has(reviewer.id)}
                          value={targets[reviewer.id] ?? ""}
                          onChange={(e) =>
                            setTargets((previous) => ({
                              ...previous,
                              [reviewer.id]: e.target.value,
                            }))
                          }
                        />
                      </td>
                      <td className="p-2">
                        {reviewer.quota?.completed ?? "—"}
                      </td>
                      <td className="p-2">
                        {reviewer.quota?.remaining ?? "—"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="text-sm text-muted-foreground">
              {selected.size} selected · total target{" "}
              {[...selected]
                .reduce((sum, id) => sum + (Number(targets[id]) || 0), 0)
                .toLocaleString()}{" "}
              reviews. For 1,000 abstracts, dual review needs 2,000 reviews (for
              example, 10 reviewers × 200).
            </p>
            <DialogFooter>
              <Button type="submit" disabled={busy || selected.size === 0}>
                {busy && <Spinner />}Save quotas
              </Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}

export function QuotaProgress({
  quota,
  available,
}: {
  quota: ReviewerQuota | null | undefined;
  available: number;
}) {
  if (!quota) return null;
  return (
    <div
      className="mb-4 rounded-lg border border-border bg-card p-4"
      aria-label="Your review assignment"
      aria-live="polite"
    >
      <p className="font-medium">Your review assignment</p>
      <p className="mt-1 text-sm">
        Target: <strong>{quota.target.toLocaleString()}</strong> · Completed:{" "}
        <strong>{quota.completed.toLocaleString()}</strong> · Remaining:{" "}
        <strong>{quota.remaining.toLocaleString()}</strong>
      </p>
      <p className="mt-1 text-sm text-muted-foreground">
        {quota.target === 0
          ? "New reviews are paused. Your completed reviews remain saved."
          : quota.remaining === 0
            ? "Assignment complete. Your completed reviews remain saved."
            : available === 0
              ? "No abstracts are currently available. Your remaining target is unchanged; an administrator can adjust it or add more abstracts."
              : `Choose any available abstract. ${available.toLocaleString()} currently need your review.`}
      </p>
    </div>
  );
}
