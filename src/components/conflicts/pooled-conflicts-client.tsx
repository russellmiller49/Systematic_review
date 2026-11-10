"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { Gavel } from "lucide-react";
import { toast } from "sonner";
import { api, apiPost, ApiError } from "@/lib/api";
import { PageHeader, StatCard } from "@/components/layout/page-header";
import { Alert, EmptyState, Skeleton } from "@/components/ui/misc";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import {
  formatAuthors,
  type CitationCardData,
} from "@/components/citations/citation-card";

type Pico = { id: string; title: string; picoNumber: number | null };
type Status = "OPEN" | "RESOLVED" | "NEEDS_SYNCHRONIZATION";
type Item = {
  id: string;
  citationIds: string[];
  stateToken: string;
  status: Status;
  synchronizationReason?: string;
  citation: {
    id: string;
    title: string;
    abstract: string | null;
    authors: CitationCardData["authors"];
    year: number | null;
    doi: string | null;
    pmid: string | null;
  };
  picos: Pico[];
  finalOutcome?: string | null;
  historicalAdjudications?: {
    projectId: string;
    citationId: string;
    conflictStatus: string;
    adjudication: {
      finalDecision: string;
      reason: string;
      adjudicator: { id: string; name: string | null };
      exclusionReason: { label: string } | null;
      createdAt: string;
    };
  }[];
  decisions: {
    projectId?: string;
    citationId?: string;
    exclusionReason?: { label: string } | null;
    reviewer: { id: string; name: string | null };
    decision: string;
    notes: string | null;
  }[];
  adjudication: {
    finalDecision: string;
    reason: string;
    adjudicator: { id: string; name: string | null };
  } | null;
};
type Response = {
  criteria: {
    id: string;
    projectId: string;
    type: string;
    category: string | null;
    text: string;
    order: number;
  }[];
  pool: { id: string; name: string };
  picos: Pico[];
  reasons: { label: string }[];
  items: Item[];
  summary: { open: number; resolved: number; needsSynchronization: number };
};
const labels: Record<Status, string> = {
  OPEN: "Open",
  RESOLVED: "Resolved",
  NEEDS_SYNCHRONIZATION: "Needs synchronization",
};

export function PooledConflictsClient({
  guidelineId,
  poolId,
}: {
  guidelineId: string;
  poolId: string;
}) {
  const [data, setData] = useState<Response | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [status, setStatus] = useState<Status>("OPEN");
  const [selected, setSelected] = useState<Item | null>(null);
  const endpoint = `/api/projects/${guidelineId}/screening/pooled/conflicts`;
  const load = useCallback(async () => {
    setLoading(true);
    setData(null);
    setError("");
    try {
      if (!poolId)
        throw new Error(
          "Choose a combined pool from the guideline screening workspace.",
        );
      const next = await api<Response>(
        `${endpoint}?poolId=${encodeURIComponent(poolId)}`,
      );
      setData(next);
      setSelected((current) =>
        current
          ? (next.items.find((item) => item.id === current.id) ?? null)
          : null,
      );
    } catch (err) {
      setSelected(null);
      setError(
        err instanceof ApiError && err.status === 403
          ? "Adjudication rights are required for every linked PICO. Reviewer decisions remain hidden."
          : err instanceof Error
            ? err.message
            : "Unable to load pooled conflicts.",
      );
    } finally {
      setLoading(false);
    }
  }, [endpoint, poolId]);
  useEffect(() => {
    setSelected(null);
    void load();
  }, [load]);
  return (
    <div className="space-y-6">
      <PageHeader
        title="Pooled abstract adjudication"
        description={
          data
            ? data.pool.name
            : "Resolve combined title-and-abstract screening conflicts."
        }
      />
      <Link
        className="text-sm underline"
        href={`/projects/${guidelineId}/screening`}
      >
        Back to guideline screening
      </Link>
      <Alert>
        Each decision applies to every linked PICO listed on that citation.
        Full-text adjudication remains separate for each PICO.
      </Alert>
      {loading ? (
        <Skeleton className="h-48" />
      ) : error ? (
        <Alert variant="error">
          <p>{error}</p>
          <Button
            variant="outline"
            className="mt-3"
            onClick={() => void load()}
          >
            Retry
          </Button>
        </Alert>
      ) : (
        data && (
          <>
            <div className="grid gap-4 sm:grid-cols-3">
              <StatCard
                label="Open pooled conflicts"
                value={data.summary.open}
              />
              <StatCard
                label="Resolved pooled conflicts"
                value={data.summary.resolved}
              />
              <StatCard
                label="Needs synchronization"
                value={data.summary.needsSynchronization}
              />
            </div>
            <div
              className="flex flex-wrap gap-2"
              role="group"
              aria-label="Filter pooled conflicts"
            >
              {(Object.keys(labels) as Status[]).map((value) => (
                <Button
                  key={value}
                  variant={status === value ? "default" : "outline"}
                  aria-pressed={status === value}
                  onClick={() => setStatus(value)}
                >
                  {labels[value]}
                </Button>
              ))}
              <Button variant="outline" onClick={() => void load()}>
                Refresh
              </Button>
            </div>
            {data.items.filter((item) => item.status === status).length ===
              0 && (
              <EmptyState
                icon={Gavel}
                title={`No ${labels[status].toLowerCase()} pooled conflicts`}
                description="Only conflicts for this combined abstract-screening pool appear here."
              />
            )}
            {data.items
              .filter((item) => item.status === status)
              .map((item) => (
                <Card key={item.id}>
                  <CardHeader>
                    <CardTitle className="text-base">
                      {item.citation.title}
                    </CardTitle>
                    <p className="text-sm text-muted-foreground">
                      {formatAuthors(item.citation.authors)}
                      {item.citation.year ? ` · ${item.citation.year}` : ""}
                    </p>
                  </CardHeader>
                  <CardContent className="space-y-4">
                    <Badge variant="secondary">{labels[item.status]}</Badge>
                    <PicoList picos={item.picos} />
                    {item.citation.abstract && (
                      <details>
                        <summary className="cursor-pointer text-sm font-medium">
                          Abstract
                        </summary>
                        <p className="mt-2 whitespace-pre-wrap text-sm">
                          {item.citation.abstract}
                        </p>
                      </details>
                    )}
                    <ReviewerDecisions item={item} />
                    <HistoricalAdjudications item={item} />
                    {item.finalOutcome && (
                      <p className="text-sm">
                        Final abstract outcome:{" "}
                        <strong>{item.finalOutcome.toLowerCase()}</strong>
                      </p>
                    )}
                    {item.adjudication && (
                      <div className="rounded-md border p-3 text-sm">
                        <p>
                          Final decision:{" "}
                          <strong>
                            {item.adjudication.finalDecision.toLowerCase()}
                          </strong>{" "}
                          ·{" "}
                          {item.adjudication.adjudicator.name ?? "Adjudicator"}
                        </p>
                        <p className="mt-1 whitespace-pre-wrap">
                          {item.adjudication.reason}
                        </p>
                      </div>
                    )}
                    {item.status === "NEEDS_SYNCHRONIZATION" ? (
                      <Alert variant="warning">
                        {item.synchronizationReason ??
                          "Linked PICO records disagree or are incomplete."}{" "}
                        This citation is read-only until the pool is
                        synchronized. Ask an administrator to review the linked
                        records.
                      </Alert>
                    ) : (
                      <Button
                        variant={item.status === "OPEN" ? "default" : "outline"}
                        onClick={() => setSelected(item)}
                      >
                        {item.status === "OPEN"
                          ? "Adjudicate across linked PICOs"
                          : "Reopen across linked PICOs"}
                      </Button>
                    )}
                  </CardContent>
                </Card>
              ))}
          </>
        )
      )}
      {selected && (
        <PooledDecisionDialog
          key={selected.id}
          item={selected}
          reasons={data?.reasons ?? []}
          criteria={data?.criteria ?? []}
          refreshing={loading}
          poolId={poolId}
          endpoint={endpoint}
          onClose={() => setSelected(null)}
          onRefresh={() => void load()}
          onDone={() => {
            setSelected(null);
            void load();
          }}
        />
      )}
    </div>
  );
}
function PicoList({ picos }: { picos: Pico[] }) {
  return (
    <div className="text-sm">
      <p className="font-medium">
        Applies to {picos.length} linked PICO{picos.length === 1 ? "" : "s"}
      </p>
      <ul className="mt-1 list-disc pl-5">
        {picos.map((pico) => (
          <li key={pico.id}>
            PICO {pico.picoNumber ?? ""} · {pico.title}
          </li>
        ))}
      </ul>
    </div>
  );
}
function PooledDecisionDialog({
  item,
  reasons,
  criteria,
  refreshing,
  poolId,
  endpoint,
  onClose,
  onRefresh,
  onDone,
}: {
  item: Item;
  reasons: Response["reasons"];
  criteria: Response["criteria"];
  refreshing: boolean;
  onRefresh: () => void;
  poolId: string;
  endpoint: string;
  onClose: () => void;
  onDone: () => void;
}) {
  const [initialStatus] = useState(item.status);
  const reopen = initialStatus === "RESOLVED";
  const [initialScope] = useState(() =>
    JSON.stringify([...item.citationIds].sort()),
  );
  const statusChanged =
    item.status !== initialStatus ||
    JSON.stringify([...item.citationIds].sort()) !== initialScope;
  const submitting = useRef(false);
  const [reviewRequired, setReviewRequired] = useState(false);
  const [reviewed, setReviewed] = useState(false);
  const [saveError, setSaveError] = useState("");
  const [decision, setDecision] = useState("");
  const [exclusion, setExclusion] = useState("");
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (
      submitting.current ||
      refreshing ||
      statusChanged ||
      (reviewRequired && !reviewed) ||
      item.status === "NEEDS_SYNCHRONIZATION" ||
      reason.trim().length < 3 ||
      (!reopen && (!decision || (decision === "EXCLUDE" && !exclusion)))
    )
      return;
    submitting.current = true;
    setSaveError("");
    setBusy(true);
    try {
      await apiPost(`${endpoint}${reopen ? "/reopen" : ""}`, {
        poolId,
        citationIds: item.citationIds,
        stateToken: item.stateToken,
        reason: reason.trim(),
        ...(!reopen
          ? {
              finalDecision: decision,
              ...(decision === "EXCLUDE" && exclusion
                ? { exclusionReasonLabel: exclusion }
                : {}),
            }
          : {}),
      });
      toast.success(
        reopen
          ? "Pooled decision reopened across linked PICOs"
          : "Pooled decision recorded across linked PICOs",
      );
      onDone();
    } catch (err) {
      if (
        err instanceof ApiError &&
        (err.status === 409 || err.status === 422 || err.status === 403)
      ) {
        setSaveError(err.message);
        toast.error(err.message);
        if (err.status === 403) onDone();
        else {
          setReviewRequired(true);
          setReviewed(false);
          setDecision("");
          setExclusion("");
          onRefresh();
        }
      } else
        toast.error(
          err instanceof Error
            ? err.message
            : "Could not save pooled adjudication",
        );
    } finally {
      submitting.current = false;
      setBusy(false);
    }
  }
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !submitting.current) onClose();
      }}
    >
      <DialogContent className="max-h-[85vh] max-w-2xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>
            {reopen
              ? "Reopen resolved pooled abstract"
              : "Adjudicate pooled conflict"}
          </DialogTitle>
          <DialogDescription>
            {reopen
              ? "Reopen the final abstract decision across all linked PICOs. Reviewer votes remain unchanged."
              : "Record one final abstract decision across all linked PICOs. Reviewer votes remain unchanged."}
          </DialogDescription>
        </DialogHeader>
        <p className="text-sm font-medium">{item.citation.title}</p>
        <PicoList picos={item.picos} />
        {saveError && <Alert variant="error">{saveError}</Alert>}
        {statusChanged && (
          <Alert variant="warning">
            This citation’s status or linked records changed. Close this dialog
            and review the current record before choosing another action. Your
            rationale remains below for reference.
          </Alert>
        )}
        {reviewRequired && !statusChanged && (
          <Alert variant="warning">
            The records have been refreshed. Review the current abstract,
            reviewer decisions, linked PICOs, and criteria before submitting
            again. Your rationale has been preserved.
          </Alert>
        )}
        {item.citation.abstract && (
          <details open={reviewRequired}>
            <summary className="cursor-pointer text-sm font-medium">
              Abstract
            </summary>
            <p className="mt-2 whitespace-pre-wrap text-sm">
              {item.citation.abstract}
            </p>
          </details>
        )}
        <ReviewerDecisions item={item} />
        <HistoricalAdjudications item={item} />
        {item.adjudication && (
          <p className="text-sm">
            Current final decision:{" "}
            {item.adjudication.finalDecision.toLowerCase()} ·{" "}
            {item.adjudication.reason}
          </p>
        )}
        {item.status === "NEEDS_SYNCHRONIZATION" && (
          <Alert variant="warning">
            {item.synchronizationReason ??
              "Linked records need synchronization."}{" "}
            Your rationale is preserved below, but this record cannot be
            changed.
          </Alert>
        )}
        {criteria.length > 0 && (
          <details className="rounded-md border p-3">
            <summary className="cursor-pointer text-sm font-medium">
              Eligibility criteria by PICO
            </summary>
            {item.picos.map((pico) => (
              <div key={pico.id} className="mt-3 text-sm">
                <p className="font-medium">
                  PICO {pico.picoNumber} · {pico.title}
                </p>
                <ul className="list-disc pl-5">
                  {criteria
                    .filter((criterion) => criterion.projectId === pico.id)
                    .map((criterion) => (
                      <li key={criterion.id}>
                        {criterion.type.toLowerCase()}
                        {criterion.category
                          ? ` · ${criterion.category}`
                          : ""}: {criterion.text}
                      </li>
                    ))}
                </ul>
              </div>
            ))}
          </details>
        )}
        <form onSubmit={submit} className="space-y-4">
          {!reopen && (
            <>
              <div className="space-y-2">
                <Label htmlFor="pooled-final-decision">Final decision</Label>
                <Select
                  id="pooled-final-decision"
                  required
                  value={decision}
                  onChange={(e) => setDecision(e.target.value)}
                  disabled={busy}
                >
                  <option value="">Choose a decision</option>
                  <option value="INCLUDE">Include</option>
                  <option value="EXCLUDE">Exclude</option>
                </Select>
              </div>
              {decision === "EXCLUDE" && (
                <div className="space-y-2">
                  <Label htmlFor="pooled-exclusion-reason">
                    Exclusion reason (required)
                  </Label>
                  <Select
                    required
                    id="pooled-exclusion-reason"
                    value={exclusion}
                    onChange={(e) => setExclusion(e.target.value)}
                    disabled={busy}
                  >
                    <option value="">Select a reason</option>
                    {reasons.map(({ label }) => (
                      <option key={label} value={label}>
                        {label}
                      </option>
                    ))}
                  </Select>
                </div>
              )}
            </>
          )}
          <div className="space-y-2">
            <Label htmlFor="pooled-rationale">Rationale (required)</Label>
            <Textarea
              id="pooled-rationale"
              required
              minLength={3}
              maxLength={5000}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              disabled={busy}
            />
          </div>
          {reviewRequired && !statusChanged && (
            <label className="flex items-start gap-2 text-sm">
              <input
                type="checkbox"
                checked={reviewed}
                disabled={refreshing || busy}
                onChange={(event) => setReviewed(event.target.checked)}
              />
              I have reviewed the refreshed records and linked PICOs.
            </label>
          )}
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              disabled={busy}
              onClick={onClose}
            >
              Cancel
            </Button>
            <Button
              type="submit"
              disabled={
                busy ||
                refreshing ||
                statusChanged ||
                (reviewRequired && !reviewed) ||
                item.status === "NEEDS_SYNCHRONIZATION" ||
                reason.trim().length < 3 ||
                (!reopen &&
                  (!decision || (decision === "EXCLUDE" && !exclusion)))
              }
            >
              {busy
                ? "Saving…"
                : reopen
                  ? "Reopen all linked PICOs"
                  : "Record for all linked PICOs"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function ReviewerDecisions({ item }: { item: Item }) {
  return (
    <div className="space-y-2 text-sm">
      <p className="font-medium">Reviewer decisions</p>
      {item.decisions.map((vote, index) => {
        const pico = item.picos.find((entry) => entry.id === vote.projectId);
        return (
          <div
            key={`${vote.reviewer.id}:${vote.citationId ?? index}`}
            className="rounded-md border p-2"
          >
            <strong>{vote.reviewer.name ?? "Reviewer"}</strong> ·{" "}
            {vote.decision.toLowerCase()}
            {pico && (
              <p>
                PICO {pico.picoNumber} · {pico.title}
              </p>
            )}
            {vote.exclusionReason && (
              <p>Exclusion reason: {vote.exclusionReason.label}</p>
            )}
            {vote.notes && <p className="whitespace-pre-wrap">{vote.notes}</p>}
          </div>
        );
      })}
    </div>
  );
}
function HistoricalAdjudications({ item }: { item: Item }) {
  if (!item.historicalAdjudications?.length) return null;
  return (
    <details
      className="rounded-md border p-3"
      open={item.status === "NEEDS_SYNCHRONIZATION"}
    >
      <summary className="cursor-pointer text-sm font-medium">
        Recorded adjudications by PICO (read-only)
      </summary>
      <div className="mt-2 space-y-3 text-sm">
        {item.historicalAdjudications.map((record, index) => {
          const pico = item.picos.find(
            (entry) => entry.id === record.projectId,
          );
          const adjudication = record.adjudication;
          return (
            <div key={`${record.citationId}:${index}`}>
              <p className="font-medium">
                {pico
                  ? `PICO ${pico.picoNumber} · ${pico.title}`
                  : "Linked PICO"}
              </p>
              <p>
                {adjudication.adjudicator.name ?? "Adjudicator"} ·{" "}
                {adjudication.finalDecision.toLowerCase()} ·{" "}
                {record.conflictStatus.toLowerCase()} ·{" "}
                {new Date(adjudication.createdAt).toLocaleString()}
              </p>
              {adjudication.exclusionReason && (
                <p>Exclusion reason: {adjudication.exclusionReason.label}</p>
              )}
              <p className="whitespace-pre-wrap">{adjudication.reason}</p>
            </div>
          );
        })}
      </div>
    </details>
  );
}
