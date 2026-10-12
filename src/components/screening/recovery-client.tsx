"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { api, apiPost } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import type { GuidelineScreeningConfiguration } from "./types";

type Summary = {
  selectedGroups: number;
  eligibleGroups: number;
  heldGroups: number;
  linkedDecisions: number;
  completedBefore: number | null;
  remainingBefore: number | null;
};
type Preview = {
  operation: "withdraw" | "restore";
  token: string | null;
  expiresAt: string;
  reviewerId: string;
  pool: { name: string; projects: { id: string; title: string }[] };
  groups: {
    id: string;
    title: string;
    copies: number;
    eligible: boolean;
    reasons: string[];
  }[];
  summary: Summary;
};
type Batch = {
  id: string;
  reviewerId: string;
  createdAt: string;
  restoredAt: string | null;
};
const holds: Record<string, string> = {
  INCONSISTENT_LINKED_STATE: "Linked screening records differ",
  FINALIZED_STAGE_RESULT: "A stage result is already final",
  FINALIZED_STAGE_HISTORY:
    "A finalized stage result exists in retained history",
  ADJUDICATION_HISTORY: "Adjudication history needs separate review",
  DOWNSTREAM_HISTORY: "Full-text or downstream work exists",
  REVIEW_CAPACITY_INCONSISTENT: "Review capacity is inconsistent",
  TARGET_VOTES_NOT_ALL_ACTIVE_EXCLUDE:
    "The reviewer has missing, inactive, or differing votes",
  POOL_OR_GROUP_CHANGED: "Pool membership or linked records changed",
  WITHDRAWN_VOTE_CHANGED: "Retained vote or assignment changed",
  RETAINED_ASSIGNMENT_CHANGED:
    "Retained assignment is missing or its reviewer, citation, stage, or status changed",
  NO_REVIEW_CAPACITY: "All review slots are now filled",
  RESTORATION_EXCEEDS_QUOTA: "Restoring would exceed the current quota",
};

export function RecoveryClient({ guidelineId }: { guidelineId: string }) {
  const base = `/api/projects/${guidelineId}/screening`;
  const [config, setConfig] = useState<GuidelineScreeningConfiguration | null>(
    null,
  );
  const [reviewers, setReviewers] = useState<
    { id: string; name: string; email: string }[]
  >([]);
  const [batches, setBatches] = useState<Batch[]>([]);
  const [reviewerId, setReviewerId] = useState("");
  const [reason, setReason] = useState("");
  const [preview, setPreview] = useState<Preview | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  useEffect(() => {
    let active = true;
    void (async () => {
      try {
        const next = await api<GuidelineScreeningConfiguration>(`${base}/pool`);
        const [history, people] = await Promise.all([
          api<Batch[]>(`${base}/recovery`),
          next.pool
            ? api<{ reviewers: typeof reviewers }>(
                `${base}/pooled/quotas?poolId=${encodeURIComponent(next.pool.id)}`,
              )
            : Promise.resolve({ reviewers: [] }),
        ]);
        if (active) {
          setConfig(next);
          setBatches(history);
          setReviewers(people.reviewers);
        }
      } catch (e) {
        if (active)
          setError(e instanceof Error ? e.message : "Could not load recovery");
      }
    })();
    return () => {
      active = false;
    };
  }, [base]);
  async function inspect(withdrawalId?: string) {
    setBusy(true);
    setPreview(null);
    setError("");
    setMessage("");
    try {
      setPreview(
        await apiPost<Preview>(
          `${base}/recovery/${withdrawalId ? "restore-preview" : "preview"}`,
          withdrawalId
            ? { withdrawalId, reason }
            : { poolId: config?.pool?.id, reviewerId, reason },
        ),
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : "Preflight failed");
    } finally {
      setBusy(false);
    }
  }
  async function apply() {
    if (!preview?.token) return;
    setBusy(true);
    setError("");
    try {
      const result = await apiPost<{ withdrawalId: string; summary: Summary }>(
        `${base}/recovery`,
        { token: preview.token },
      );
      setPreview(null);
      setMessage(
        `${result.summary.eligibleGroups} logical reviews ${preview.operation === "withdraw" ? "withdrawn" : "restored"}. Audit reference: ${result.withdrawalId}.`,
      );
      setBatches(await api<Batch[]>(`${base}/recovery`));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Recovery failed");
      // Keep the exact token for an idempotent retry after an uncertain response.
    } finally {
      setBusy(false);
    }
  }
  const valid = reason.trim().length >= 3;
  return (
    <div className="mx-auto max-w-4xl space-y-5 p-4 sm:p-6">
      <Link
        href={`/projects/${guidelineId}/settings`}
        className="text-sm text-primary underline"
      >
        Back to settings
      </Link>
      <h1 className="text-2xl font-semibold">Screening recovery</h1>
      <p>
        Select one reviewer to withdraw their current title-and-abstract Exclude
        votes across the saved pool. Original votes and audit history are
        retained. Include, Maybe, individual PICO queues, and other reviewers'
        votes are preserved.
      </p>
      <p className="text-sm text-muted-foreground">
        Preflight makes no changes. Finalized results, adjudication, downstream
        work, and inconsistent linked records are held for separate review.
        Restoration requires unchanged retained votes and available review
        slots.
      </p>
      {error && (
        <p role="alert" className="rounded border border-destructive p-3">
          {error}
        </p>
      )}
      {message && (
        <p role="status" className="rounded border p-3">
          {message}
        </p>
      )}
      {config?.pool && (
        <form
          className="space-y-4 rounded border p-4"
          onSubmit={(e) => {
            e.preventDefault();
            void inspect();
          }}
        >
          <p className="font-medium">{config.pool.name}</p>
          <ul className="list-inside list-disc text-sm">
            {config.pool.picos.map((p) => (
              <li key={p.id}>
                PICO {p.picoNumber} · {p.title}
              </li>
            ))}
          </ul>
          <div className="space-y-1">
            <Label htmlFor="recovery-reviewer">Reviewer</Label>
            <select
              id="recovery-reviewer"
              required
              disabled={busy}
              className="block w-full rounded border bg-background p-2"
              value={reviewerId}
              onChange={(e) => {
                setReviewerId(e.target.value);
                setPreview(null);
              }}
            >
              <option value="">Choose a reviewer</option>
              {reviewers.map((r) => (
                <option value={r.id} key={r.id}>
                  {r.name} ({r.email})
                </option>
              ))}
            </select>
          </div>
          <div className="space-y-1">
            <Label htmlFor="recovery-reason">
              Reason for this recovery or restoration
            </Label>
            <Input
              id="recovery-reason"
              required
              minLength={3}
              maxLength={2000}
              disabled={busy}
              value={reason}
              onChange={(e) => {
                setReason(e.target.value);
                setPreview(null);
              }}
            />
          </div>
          <Button type="submit" disabled={busy || !reviewerId || !valid}>
            Preview withdrawal
          </Button>
        </form>
      )}
      {config && !config.pool && <p>No saved screening pool is configured.</p>}
      {preview && (
        <section
          aria-label="Recovery preflight"
          className="space-y-3 rounded border p-4"
        >
          <h2 className="text-lg font-medium">
            {preview.operation === "withdraw" ? "Withdrawal" : "Restoration"}{" "}
            preflight
          </h2>
          <p>
            {preview.pool.name} ·{" "}
            {reviewers.find((r) => r.id === preview.reviewerId)?.name ??
              preview.reviewerId}
          </p>
          <p>
            {preview.summary.selectedGroups} logical groups selected;{" "}
            {preview.summary.eligibleGroups} eligible;{" "}
            {preview.summary.heldGroups} held; {preview.summary.linkedDecisions}{" "}
            linked votes to change.
          </p>
          <p>
            Current logical credit:{" "}
            {preview.summary.completedBefore ?? "No saved quota"}; quota
            remaining: {preview.summary.remainingBefore ?? "No fixed target"}.
          </p>
          <p className="text-sm">
            Plan expires at {new Date(preview.expiresAt).toLocaleTimeString()}.
            Any screening or scope change requires a fresh preflight.
          </p>
          <ul className="space-y-2">
            {preview.groups.map((g) => (
              <li key={g.id} className="break-words border-t pt-2">
                <p>
                  {g.title} · {g.copies} linked copies ·{" "}
                  {g.eligible ? "Eligible" : "Held"}
                </p>
                {g.reasons.map((r) => (
                  <p key={r} className="text-sm text-muted-foreground">
                    {holds[r] ?? r}
                  </p>
                ))}
              </li>
            ))}
          </ul>
          <Button
            disabled={busy || !preview.token}
            onClick={() => void apply()}
          >
            {busy
              ? "Applying…"
              : preview.operation === "withdraw"
                ? `Withdraw ${preview.summary.eligibleGroups} eligible logical reviews`
                : `Restore ${preview.summary.eligibleGroups} logical reviews`}
          </Button>
        </section>
      )}
      <section aria-label="Recovery history" className="space-y-3">
        <h2 className="text-lg font-medium">Recent recovery history</h2>
        <p className="text-sm">
          Enter a reason above, then preview restoration of an entire batch.
          Every group must pass preflight for restoration to proceed.
        </p>
        {batches.map((b) => (
          <div key={b.id} className="space-y-2 break-words rounded border p-3">
            <p>
              {reviewers.find((r) => r.id === b.reviewerId)?.name ??
                b.reviewerId}{" "}
              · {new Date(b.createdAt).toLocaleString()}
            </p>
            <p className="text-xs">{b.id}</p>
            {b.restoredAt ? (
              <p>Restored {new Date(b.restoredAt).toLocaleString()}</p>
            ) : (
              <Button
                variant="outline"
                disabled={busy || !valid}
                onClick={() => void inspect(b.id)}
              >
                Preview restoration
              </Button>
            )}
          </div>
        ))}
        {!batches.length && (
          <p className="text-sm text-muted-foreground">
            No recovery batches recorded.
          </p>
        )}
      </section>
    </div>
  );
}
