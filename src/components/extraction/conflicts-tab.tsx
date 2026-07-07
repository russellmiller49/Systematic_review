"use client";

// Conflicts tab: field-level extraction disagreements (adjudicators/admins only — the API
// 403s for everyone else). Shows each extractor's value side by side; adjudication records
// a typed finalValue + rationale. The adjudicated finalValue is the authoritative value
// (exports prefer it over either extractor's entry).

import { useCallback, useEffect, useState } from "react";
import { Gavel, Swords } from "lucide-react";
import { toast } from "sonner";
import { api, apiPost, ApiError } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Alert, EmptyState, Skeleton, Spinner } from "@/components/ui/misc";
import { Select } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { FieldValueEditor } from "./field-value-editor";
import { ConflictStatusBadge } from "./status-badges";
import { formatFieldValue, hasCap, FIELD_TYPE_LABELS, type ConflictData } from "./types";

type StatusFilter = "OPEN" | "RESOLVED" | "VOIDED" | "ALL";

export function ConflictsTab({
  projectId,
  roles,
}: {
  projectId: string;
  roles: string[] | null;
}) {
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("OPEN");
  const [conflicts, setConflicts] = useState<ConflictData[] | null>(null);
  const [denied, setDenied] = useState(false);

  const [adjudicating, setAdjudicating] = useState<ConflictData | null>(null);
  const [finalValue, setFinalValue] = useState<unknown>(null);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);

  const canAdjudicate = hasCap(roles, "extraction.adjudicate");

  const load = useCallback(() => {
    if (roles === null || !canAdjudicate) return;
    setConflicts(null);
    const qs = statusFilter === "ALL" ? "" : `?status=${statusFilter}`;
    api<ConflictData[]>(`/api/projects/${projectId}/extraction/conflicts${qs}`)
      .then((rows) => {
        setDenied(false);
        setConflicts(rows);
      })
      .catch((err) => {
        setConflicts([]);
        if (err instanceof ApiError && err.status === 403) setDenied(true);
        else toast.error("Failed to load conflicts");
      });
  }, [projectId, statusFilter, roles, canAdjudicate]);

  useEffect(load, [load]);

  if (roles === null) {
    return <Skeleton className="h-40" />;
  }
  if (!canAdjudicate || denied) {
    return (
      <Alert variant="info">
        Extraction conflict review requires adjudicator or admin access. Conflicts open
        automatically when two completed forms disagree on a field — your own forms stay
        blinded until then.
      </Alert>
    );
  }

  function openAdjudicate(c: ConflictData) {
    setAdjudicating(c);
    setFinalValue(null);
    setReason("");
  }

  async function submitAdjudication(e: React.FormEvent) {
    e.preventDefault();
    if (!adjudicating) return;
    setBusy(true);
    try {
      await apiPost(
        `/api/projects/${projectId}/extraction/conflicts/${adjudicating.id}/adjudicate`,
        { finalValue, reason: reason.trim() },
      );
      toast.success("Conflict adjudicated — the field is now locked");
      setAdjudicating(null);
      load();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Failed to adjudicate conflict");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-muted-foreground">
          Field-level disagreements between completed extraction forms.
        </p>
        <div className="w-44">
          <Select
            aria-label="Filter by status"
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value as StatusFilter)}
          >
            <option value="OPEN">Open</option>
            <option value="RESOLVED">Resolved</option>
            <option value="VOIDED">Voided</option>
            <option value="ALL">All</option>
          </Select>
        </div>
      </div>

      {conflicts === null ? (
        <div className="space-y-3">
          <Skeleton className="h-36" />
          <Skeleton className="h-36" />
        </div>
      ) : conflicts.length === 0 ? (
        <EmptyState
          icon={Swords}
          title={statusFilter === "OPEN" ? "No open conflicts" : "No conflicts"}
          description="Conflicts appear when two completed extraction forms record different values for the same field."
        />
      ) : (
        <div className="space-y-3">
          {conflicts.map((c) => (
            <Card key={c.id}>
              <CardContent className="p-5">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <h3 className="font-semibold">{c.field.label}</h3>
                      <span className="font-mono text-xs text-muted-foreground">
                        {c.field.key}
                      </span>
                      <ConflictStatusBadge status={c.status} />
                    </div>
                    <p className="mt-0.5 text-sm text-muted-foreground">
                      {c.study.label} · {c.template.name} v{c.template.version} · opened{" "}
                      {new Date(c.openedAt).toLocaleDateString()}
                    </p>
                  </div>
                  {c.status === "OPEN" && (
                    <Button size="sm" onClick={() => openAdjudicate(c)}>
                      <Gavel /> Adjudicate
                    </Button>
                  )}
                </div>

                <div className="mt-3 grid gap-3 sm:grid-cols-2">
                  {c.forms.map((f) => (
                    <div key={f.formId} className="rounded-md border border-border bg-background p-3">
                      <p className="text-xs font-medium text-muted-foreground">
                        {f.extractor.name}
                      </p>
                      <p className={f.value === null ? "mt-1 text-sm italic text-muted-foreground" : "mt-1 text-sm font-medium"}>
                        {formatFieldValue(c.field, f.value)}
                      </p>
                      {f.sourceQuote && (
                        <p className="mt-1 text-xs italic text-muted-foreground">
                          &ldquo;{f.sourceQuote}&rdquo;
                          {f.pageNumber ? ` (p. ${f.pageNumber})` : ""}
                        </p>
                      )}
                    </div>
                  ))}
                </div>

                {c.status === "RESOLVED" && c.adjudication && (
                  <div className="mt-3 rounded-md border border-include/30 bg-include-muted p-3">
                    <p className="text-xs font-medium text-include">
                      Final value (adjudicated — authoritative for exports)
                    </p>
                    <p className="mt-1 text-sm font-semibold">
                      {formatFieldValue(c.field, c.adjudication.finalValue)}
                    </p>
                    <p className="mt-1 text-xs text-muted-foreground">
                      {c.adjudication.adjudicator.name} ·{" "}
                      {new Date(c.adjudication.createdAt).toLocaleString()} —{" "}
                      {c.adjudication.reason}
                    </p>
                  </div>
                )}
                {c.status === "VOIDED" && (
                  <p className="mt-3 text-xs text-muted-foreground">
                    Voided automatically — the extractors&apos; values converged (or the conflict
                    became moot).
                  </p>
                )}
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      {/* Adjudicate dialog */}
      <Dialog open={adjudicating !== null} onOpenChange={(o) => !o && setAdjudicating(null)}>
        <DialogContent className="max-h-[85vh] max-w-xl overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Adjudicate — {adjudicating?.field.label}</DialogTitle>
            <DialogDescription>
              {adjudicating
                ? `${adjudicating.study.label} · ${FIELD_TYPE_LABELS[adjudicating.field.type]} field. The final value becomes authoritative and locks the field on both forms.`
                : ""}
            </DialogDescription>
          </DialogHeader>
          {adjudicating && (
            <form onSubmit={submitAdjudication} className="space-y-4">
              <div className="grid gap-2 sm:grid-cols-2">
                {adjudicating.forms.map((f) => (
                  <div key={f.formId} className="rounded-md border border-border p-3">
                    <p className="text-xs font-medium text-muted-foreground">
                      {f.extractor.name}
                    </p>
                    <p className={f.value === null ? "mt-1 text-sm italic text-muted-foreground" : "mt-1 text-sm"}>
                      {formatFieldValue(adjudicating.field, f.value)}
                    </p>
                    {f.value !== null && (
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        className="mt-2"
                        onClick={() => setFinalValue(f.value)}
                      >
                        Use this value
                      </Button>
                    )}
                  </div>
                ))}
              </div>
              <div className="space-y-1.5">
                <Label htmlFor={`adj-${adjudicating.field.id}`}>Final value</Label>
                <FieldValueEditor
                  field={adjudicating.field}
                  value={finalValue}
                  onCommit={setFinalValue}
                  commitOnChange
                  idPrefix="adj"
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="adj-reason">Rationale</Label>
                <Textarea
                  id="adj-reason"
                  required
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                  placeholder="Why this value is correct (recorded in the audit trail)."
                  rows={3}
                />
              </div>
              <DialogFooter>
                <Button
                  type="submit"
                  disabled={busy || finalValue === null || reason.trim().length < 3}
                >
                  {busy && <Spinner />} <Gavel /> Record final value
                </Button>
              </DialogFooter>
            </form>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
