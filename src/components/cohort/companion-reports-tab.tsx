"use client";

// Companion-report review: detect reports of the same underlying cohort among the
// project's included/study-linked citations, then link them into a shared study (or
// reject the suggestion). Detection + decisions require project.edit; everyone with
// project.view can inspect the candidates.

import { useCallback, useEffect, useState } from "react";
import { GitFork, ScanSearch } from "lucide-react";
import { toast } from "sonner";
import { api, apiPost, ApiError } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { EmptyState, Skeleton, Spinner } from "@/components/ui/misc";
import { CandidateCard } from "./candidate-card";
import type { CohortCandidate, CohortRunSummary } from "./types";

export function CompanionReportsTab({
  projectId,
  canManage,
}: {
  projectId: string;
  canManage: boolean;
}) {
  const [candidates, setCandidates] = useState<CohortCandidate[] | null>(null);
  const [running, setRunning] = useState(false);
  const [lastRun, setLastRun] = useState<CohortRunSummary | null>(null);
  const [showDecided, setShowDecided] = useState(false);

  const load = useCallback(() => {
    api<CohortCandidate[]>(`/api/projects/${projectId}/cohort/candidates`)
      .then(setCandidates)
      .catch(() => {
        setCandidates([]);
        toast.error("Failed to load companion-report candidates");
      });
  }, [projectId]);

  useEffect(load, [load]);

  async function runDetection() {
    setRunning(true);
    try {
      const summary = await apiPost<CohortRunSummary>(`/api/projects/${projectId}/cohort/run`);
      setLastRun(summary);
      toast.success(
        `Detection proposed ${summary.candidates} companion pair${summary.candidates === 1 ? "" : "s"}`,
        {
          description: `${summary.populationSize} citations scanned · ${summary.newlySuggested} new · ${summary.refreshed} refreshed · ${summary.removed} removed`,
        },
      );
      load();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Failed to run detection");
    } finally {
      setRunning(false);
    }
  }

  const suggested = candidates?.filter((c) => c.status === "SUGGESTED") ?? [];
  const decided = candidates?.filter((c) => c.status !== "SUGGESTED") ?? [];

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-base font-semibold">Companion reports</h2>
          <p className="max-w-2xl text-sm text-muted-foreground">
            Multiple reports of the same trial cohort (follow-ups, secondary analyses)
            should share one study so participants are never double-counted. Detection
            matches shared trial-registry ids, then author / affiliation / title / year
            overlap.
          </p>
        </div>
        {canManage && (
          <Button onClick={runDetection} disabled={running}>
            {running ? <Spinner /> : <ScanSearch />} Run detection
          </Button>
        )}
      </div>

      {lastRun !== null && (
        <p className="text-xs text-muted-foreground">
          Last run: {lastRun.candidates} candidate{lastRun.candidates === 1 ? "" : "s"} from{" "}
          {lastRun.populationSize} citations
          {lastRun.populationCapped ? " (population capped)" : ""} · {lastRun.newlySuggested} new
          · {lastRun.refreshed} refreshed · {lastRun.removed} removed
          {lastRun.backfilled > 0 ? ` · ${lastRun.backfilled} citations backfilled` : ""}
        </p>
      )}

      {candidates === null ? (
        <div className="space-y-3">
          <Skeleton className="h-24" />
          <Skeleton className="h-24" />
        </div>
      ) : suggested.length === 0 ? (
        <EmptyState
          icon={GitFork}
          title="No suggested companion reports"
          description={
            canManage
              ? "Run detection to scan included and study-linked citations for reports of the same cohort."
              : "No open suggestions. An administrator can run detection from this tab."
          }
          action={
            canManage ? (
              <Button size="sm" onClick={runDetection} disabled={running}>
                {running ? <Spinner /> : <ScanSearch />} Run detection
              </Button>
            ) : undefined
          }
        />
      ) : (
        <div className="space-y-3">
          {suggested.map((candidate) => (
            <CandidateCard
              key={candidate.id}
              projectId={projectId}
              candidate={candidate}
              canManage={canManage}
              onChanged={load}
            />
          ))}
        </div>
      )}

      {decided.length > 0 && (
        <div className="space-y-3">
          <Button variant="ghost" size="sm" onClick={() => setShowDecided((v) => !v)}>
            {showDecided ? "Hide" : "Show"} decided ({decided.length})
          </Button>
          {showDecided &&
            decided.map((candidate) => (
              <CandidateCard
                key={candidate.id}
                projectId={projectId}
                candidate={candidate}
                canManage={canManage}
                onChanged={load}
              />
            ))}
        </div>
      )}
    </div>
  );
}
