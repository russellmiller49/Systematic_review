"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Check, Layers3, X } from "lucide-react";
import { toast } from "sonner";
import { api, apiPost, ApiError } from "@/lib/api";
import { CitationCard } from "@/components/citations/citation-card";
import { PageHeader, StatCard } from "@/components/layout/page-header";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
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
import { Alert, EmptyState, Skeleton, Spinner } from "@/components/ui/misc";
import { PooledAssignDialog } from "./pooled-assign-dialog";
import type { PooledPico, PooledQueueItem, PooledQueueResponse } from "./types";

interface GuidelineScreeningInfo {
  title: string;
  capabilities: string[];
  subProjects: {
    id: string;
    title: string;
    researchQuestion: string | null;
    status: string;
  }[];
}

function buildQueuePath(guidelineId: string, poolId: string) {
  const params = new URLSearchParams();
  params.set("poolId", poolId);
  return `/api/projects/${guidelineId}/screening/pooled?${params.toString()}`;
}

export function PooledScreeningWorkspace({
  guidelineId,
  guideline,
  pool,
  showHeader = true,
}: {
  guidelineId: string;
  guideline: GuidelineScreeningInfo;
  pool: { id: string; name: string; picos: PooledPico[] };
  showHeader?: boolean;
}) {
  const [queue, setQueue] = useState<PooledQueueResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [excludeOpen, setExcludeOpen] = useState(false);
  const requestGeneration = useRef(0);
  const canConfigure = guideline.capabilities.includes("screening.configure");
  const canScreen = guideline.capabilities.includes("screening.decide");

  const loadQueue = useCallback(async () => {
    if (!canScreen) {
      setQueue(null);
      setError(null);
      return;
    }
    const generation = ++requestGeneration.current;
    setLoading(true);
    try {
      const response = await api<PooledQueueResponse>(
        buildQueuePath(guidelineId, pool.id),
      );
      if (generation !== requestGeneration.current) return;
      setQueue(response);
      setError(null);
    } catch (caught) {
      if (generation !== requestGeneration.current) return;
      setQueue(null);
      setError(caught instanceof ApiError ? caught.message : "Failed to load the combined pool");
    } finally {
      if (generation === requestGeneration.current) setLoading(false);
    }
  }, [canScreen, guidelineId, pool.id]);

  useEffect(() => {
    void loadQueue();
  }, [loadQueue]);

  const current = queue?.items[0] ?? null;
  const canExclude = (queue?.reasons.length ?? 0) > 0;
  const currentKey = current?.citationIds.join(":") ?? "";
  useEffect(() => {
    setNote("");
    setExcludeOpen(false);
  }, [currentKey]);

  const submitDecision = useCallback(
    async (
      item: PooledQueueItem,
      decision: "INCLUDE" | "EXCLUDE",
      exclusionReasonLabel?: string,
      decisionNote = note,
    ) => {
      setBusy(true);
      try {
        const result = await apiPost<{
          appliedToCitationRecords: number;
          appliedToPicos: number;
        }>(`/api/projects/${guidelineId}/screening/pooled`, {
          poolId: pool.id,
          citationIds: item.citationIds,
          decision,
          exclusionReasonLabel: exclusionReasonLabel ?? null,
          notes: decisionNote.trim() || null,
        });
        toast.success(
          `${decision === "INCLUDE" ? "Included" : "Excluded"} across ${result.appliedToPicos} PICO${result.appliedToPicos === 1 ? "" : "s"}`,
          {
            description: `${result.appliedToCitationRecords} linked citation record${result.appliedToCitationRecords === 1 ? "" : "s"} updated.`,
          },
        );
        setExcludeOpen(false);
        setNote("");
        await loadQueue();
      } catch (caught) {
        toast.error(caught instanceof ApiError ? caught.message : "Failed to save the pooled decision");
      } finally {
        setBusy(false);
      }
    },
    [guidelineId, loadQueue, note, pool.id],
  );

  useEffect(() => {
    if (!current || busy || excludeOpen) return;
    const listener = (event: KeyboardEvent) => {
      const target = event.target;
      if (
        target instanceof HTMLElement &&
        (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable)
      ) {
        return;
      }
      const key = event.key.toLowerCase();
      if (key === "i") {
        event.preventDefault();
        void submitDecision(current, "INCLUDE");
      } else if (key === "e" && canExclude) {
        event.preventDefault();
        setExcludeOpen(true);
      }
    };
    window.addEventListener("keydown", listener);
    return () => window.removeEventListener("keydown", listener);
  }, [busy, canExclude, current, excludeOpen, submitDecision]);

  return (
    <div className="space-y-6">
      {showHeader && (
        <PageHeader
          title={pool.name}
          description="Review each unique abstract once and apply one include or exclude decision to every linked PICO record in this saved pool."
        />
      )}

      <Card>
        <CardHeader className="gap-3 sm:flex-row sm:items-start sm:justify-between sm:space-y-0">
          <div className="space-y-1.5">
            <CardTitle className="flex items-center gap-2 text-base">
              <Layers3 className="h-4 w-4" /> PICO pool
            </CardTitle>
            <CardDescription>
              This pool is configured in guideline Settings. Only an Owner or Admin can change
              its name or PICO membership.
            </CardDescription>
          </div>
          <div className="flex flex-wrap gap-2">
            {canConfigure && queue && (
              <PooledAssignDialog
                guidelineId={guidelineId}
                poolId={pool.id}
                poolName={pool.name}
                reviewersPerCitation={queue.configuration.reviewersPerCitation}
                onAssigned={loadQueue}
              />
            )}
          </div>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="grid gap-2 md:grid-cols-2">
            {pool.picos.map((project) => (
              <div
                key={project.id}
                className="rounded-md border border-border px-3 py-2.5"
              >
                <span className="text-sm font-medium">
                  PICO {project.picoNumber} · {project.title}
                </span>
                {project.researchQuestion && (
                  <span className="mt-0.5 block line-clamp-2 text-xs text-muted-foreground">
                    {project.researchQuestion}
                  </span>
                )}
              </div>
            ))}
          </div>
        </CardContent>
      </Card>

      {!canScreen && (
        <Alert variant="warning">
          Your guideline role does not include abstract screening. An Owner or Admin can add a
          Reviewer, Adjudicator, or Trainee role in guideline settings.
        </Alert>
      )}
      {error && <Alert variant="error">{error}</Alert>}

      {loading ? (
        <div className="space-y-4">
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            {Array.from({ length: 4 }, (_, index) => (
              <Skeleton key={index} className="h-24" />
            ))}
          </div>
          <Skeleton className="h-96" />
        </div>
      ) : queue ? (
        <>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <StatCard
              label="Unique abstracts"
              value={queue.summary.pooledAbstracts}
              hint={`${queue.summary.linkedCitationRecords} PICO citation records`}
            />
            <StatCard
              label="Cross-PICO overlaps"
              value={queue.summary.overlaps}
              hint="Shown once with every linked PICO tag"
            />
            <StatCard
              label="Ready for you"
              value={queue.summary.ready}
              hint={`${queue.summary.awaitingOtherReviewers} awaiting other reviewers`}
            />
            <StatCard
              label="Needs pooled assignment"
              value={queue.summary.needsAssignment}
              hint={`${queue.summary.settledOrOutOfSync} settled or out of sync`}
            />
          </div>

          <Alert>
            Make one overall decision. You do not choose a PICO at decision time; the same
            reviewer decision and note are written to every PICO tag shown on the abstract.
          </Alert>

          {queue.summary.needsAssignment > 0 && canConfigure && (
            <Alert variant="warning">
              {queue.summary.needsAssignment} pooled abstract
              {queue.summary.needsAssignment === 1 ? " is" : "s are"} not consistently assigned
              across all linked PICO records. Use <strong>Assign pooled reviewers</strong> above
              to make those abstracts actionable.
            </Alert>
          )}

          {current ? (
            <CitationCard citation={current.citation} clampAbstract={false}>
              <div className="space-y-4">
                <div>
                  <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                    Found in
                  </p>
                  <div className="flex flex-wrap gap-2">
                    {current.picos.map((pico) => (
                      <Badge key={pico.id} variant="secondary" title={pico.researchQuestion ?? pico.title}>
                        PICO {pico.picoNumber} · {pico.title}
                      </Badge>
                    ))}
                  </div>
                </div>

                <div className="space-y-1.5">
                  <Label htmlFor="pooled-screening-note">
                    Reviewer note <span className="font-normal text-muted-foreground">(optional)</span>
                  </Label>
                  <Textarea
                    id="pooled-screening-note"
                    value={note}
                    onChange={(event) => setNote(event.target.value)}
                    placeholder="This note will be copied to every linked PICO record."
                    maxLength={20_000}
                  />
                </div>

                <div className="flex flex-wrap gap-2">
                  <Button
                    variant="include"
                    disabled={busy}
                    onClick={() => void submitDecision(current, "INCLUDE")}
                  >
                    {busy ? <Spinner /> : <Check />} Include in all linked PICOs
                    <kbd className="ml-1 rounded bg-black/15 px-1.5 py-0.5 text-[10px]">I</kbd>
                  </Button>
                  <Button
                    variant="exclude"
                    disabled={busy || queue.reasons.length === 0}
                    onClick={() => setExcludeOpen(true)}
                  >
                    <X /> Exclude from all linked PICOs
                    <kbd className="ml-1 rounded bg-black/15 px-1.5 py-0.5 text-[10px]">E</kbd>
                  </Button>
                </div>
                <p className="text-xs text-muted-foreground">
                  {queue.total.toLocaleString()} pooled abstract{queue.total === 1 ? "" : "s"} ready
                  for your review; up to 25 are loaded at a time.
                </p>
                {queue.reasons.length === 0 && (
                  <Alert variant="warning">
                    Exclusion is unavailable because the pooled PICOs do not share an active
                    title/abstract exclusion-reason label. Add the same reason subgroup to each
                    pooled PICO.
                  </Alert>
                )}
              </div>
            </CitationCard>
          ) : (
            <EmptyState
              icon={Check}
              title="No pooled abstracts are ready for you"
              description={
                queue.summary.awaitingOtherReviewers > 0
                  ? "You have completed your available combined screening decisions. Some abstracts are waiting for the other assigned reviewers."
                  : queue.summary.needsAssignment > 0
                    ? "The remaining abstracts need consistent reviewer assignments across their linked PICOs."
                    : "This saved pool has no undecided abstracts in your combined queue."
              }
            />
          )}

          <PooledExcludeDialog
            open={excludeOpen}
            onOpenChange={setExcludeOpen}
            reasons={queue.reasons}
            note={note}
            busy={busy}
            onConfirm={(reason, dialogNote) => {
              if (current) void submitDecision(current, "EXCLUDE", reason, dialogNote);
            }}
          />
        </>
      ) : null}
    </div>
  );
}

function PooledExcludeDialog({
  open,
  onOpenChange,
  reasons,
  note,
  busy,
  onConfirm,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  reasons: { label: string }[];
  note: string;
  busy: boolean;
  onConfirm: (reason: string, note: string) => void;
}) {
  const [reason, setReason] = useState("");
  const [dialogNote, setDialogNote] = useState(note);

  useEffect(() => {
    if (open) {
      setReason("");
      setDialogNote(note);
    }
  }, [note, open]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Exclude from every linked PICO</DialogTitle>
          <DialogDescription>
            Choose one reason subgroup shared by all pooled PICOs. The overall exclusion and
            note will be copied to each linked citation record.
          </DialogDescription>
        </DialogHeader>
        <form
          className="space-y-4"
          onSubmit={(event) => {
            event.preventDefault();
            if (reason) onConfirm(reason, dialogNote);
          }}
        >
          <div className="space-y-1.5">
            <Label htmlFor="pooled-exclusion-reason">Exclusion reason subgroup</Label>
            <Select
              id="pooled-exclusion-reason"
              required
              value={reason}
              onChange={(event) => setReason(event.target.value)}
            >
              <option value="" disabled>Select a reason…</option>
              {reasons.map((option) => (
                <option key={option.label} value={option.label}>{option.label}</option>
              ))}
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="pooled-exclusion-note">Reviewer note (optional)</Label>
            <Textarea
              id="pooled-exclusion-note"
              value={dialogNote}
              onChange={(event) => setDialogNote(event.target.value)}
              maxLength={20_000}
            />
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" variant="exclude" disabled={!reason || busy}>
              {busy ? <Spinner /> : <X />} Exclude across linked PICOs
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
