"use client";

import { useCallback, useEffect, useState } from "react";
import { Ban, RefreshCw, Sparkles } from "lucide-react";
import { toast } from "sonner";
import { api, apiPatch, apiPost, ApiError } from "@/lib/api";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/misc";
import type {
  PrescreenListResponse,
  PrescreenRun,
  PrescreenRunStatus,
  ProjectAiStatus,
  ScreeningStageSummary,
} from "./types";

const POLL_MS = 10_000;

const STATUS_LABEL: Record<PrescreenRunStatus, string> = {
  PENDING: "Submitting…",
  SUBMITTED: "Processing at provider",
  COMPLETED: "Completed",
  FAILED: "Failed",
  CANCELED: "Canceled",
};

const STATUS_VARIANT: Record<PrescreenRunStatus, "include" | "exclude" | "maybe" | "muted"> = {
  PENDING: "maybe",
  SUBMITTED: "maybe",
  COMPLETED: "include",
  FAILED: "exclude",
  CANCELED: "muted",
};

// AI prescreen control panel (screening.configure holders, TITLE_ABSTRACT tab only).
// Drives the batch lifecycle: start → auto-poll every 10s while in flight → results land
// as ScreeningSuggestion rows and the queue remounts. There is no background worker — a
// run only progresses while someone polls (this panel, or the Refresh button).
export function PrescreenPanel({
  projectId,
  stage,
  ai,
  onStageChanged,
  onSuggestionsChanged,
}: {
  projectId: string;
  stage: ScreeningStageSummary;
  ai: ProjectAiStatus;
  onStageChanged: (patch: { aiShowScores: boolean; aiRankingEnabled: boolean }) => void;
  onSuggestionsChanged: () => void;
}) {
  const baseUrl = `/api/projects/${projectId}/screening/stages/${stage.id}/prescreen`;
  const [data, setData] = useState<PrescreenListResponse | null>(null);
  const [rescore, setRescore] = useState(false);
  const [starting, setStarting] = useState(false);
  const [polling, setPolling] = useState(false);
  const [savingToggle, setSavingToggle] = useState(false);

  const load = useCallback(async () => {
    setData(await api<PrescreenListResponse>(baseUrl));
  }, [baseUrl]);

  useEffect(() => {
    load().catch((err) => {
      toast.error(err instanceof ApiError ? err.message : "Failed to load AI prescreen status");
      setData({ runs: [], eligible: { unscored: 0, unsettled: 0 } });
    });
  }, [load]);

  const latest = data?.runs[0] ?? null;
  const inFlight = latest !== null && (latest.status === "PENDING" || latest.status === "SUBMITTED");

  const poll = useCallback(
    async (manual: boolean) => {
      if (!latest || latest.status !== "SUBMITTED") return;
      setPolling(true);
      try {
        const updated = await apiPost<PrescreenRun>(
          `/api/projects/${projectId}/screening/prescreen-runs/${latest.id}/poll`,
        );
        if (updated.status === "COMPLETED") {
          toast.success(
            `AI prescreen finished — ${updated.succeededCount} of ${updated.totalCount} citations scored`,
          );
          await load();
          onSuggestionsChanged();
        } else if (updated.status === "FAILED") {
          toast.error(`AI prescreen failed${updated.error ? `: ${updated.error}` : ""}`);
          await load();
        } else if (manual) {
          toast.info("Still processing at the provider — scores land here when it finishes.");
        }
      } catch (err) {
        if (manual) {
          toast.error(err instanceof ApiError ? err.message : "Could not check the run status");
        }
      } finally {
        setPolling(false);
      }
    },
    [latest, projectId, load, onSuggestionsChanged],
  );

  // Auto-poll while a run is in flight and this panel is mounted.
  useEffect(() => {
    if (!inFlight) return;
    const timer = setInterval(() => {
      void poll(false);
    }, POLL_MS);
    return () => clearInterval(timer);
  }, [inFlight, poll]);

  async function start() {
    setStarting(true);
    try {
      await apiPost(baseUrl, { rescoreExisting: rescore });
      toast.success("Prescreen batch submitted — results usually arrive within minutes.");
      setRescore(false);
      await load();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Failed to start the prescreen run");
    } finally {
      setStarting(false);
    }
  }

  async function cancel() {
    if (!latest) return;
    try {
      await apiPost(`/api/projects/${projectId}/screening/prescreen-runs/${latest.id}/cancel`);
      toast.success("Prescreen run canceled");
      await load();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Failed to cancel the run");
    }
  }

  async function toggle(patch: { aiShowScores?: boolean; aiRankingEnabled?: boolean }) {
    setSavingToggle(true);
    try {
      const updated = await apiPatch<{ aiShowScores: boolean; aiRankingEnabled: boolean }>(
        `/api/projects/${projectId}/screening/stages/${stage.id}`,
        patch,
      );
      onStageChanged({
        aiShowScores: updated.aiShowScores,
        aiRankingEnabled: updated.aiRankingEnabled,
      });
      onSuggestionsChanged(); // the queue payload/order depends on these toggles
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Failed to update the stage setting");
    } finally {
      setSavingToggle(false);
    }
  }

  const unscored = data?.eligible.unscored ?? 0;
  const unsettled = data?.eligible.unsettled ?? 0;
  const runDisabled =
    data === null || starting || inFlight || (rescore ? unsettled === 0 : unscored === 0);

  return (
    <div className="space-y-3 rounded-lg border border-border bg-card px-4 py-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <Sparkles className="h-4 w-4 shrink-0 text-muted-foreground" />
          <span className="text-sm font-medium">AI prescreening</span>
          <Badge variant="secondary">
            {ai.provider} · {ai.screeningModel}
          </Badge>
        </div>
        {latest && (
          <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
            <Badge variant={STATUS_VARIANT[latest.status]}>{STATUS_LABEL[latest.status]}</Badge>
            {latest.status === "COMPLETED" && (
              <span>
                {latest.succeededCount} of {latest.totalCount} scored
                {latest.failedCount > 0 ? ` · ${latest.failedCount} failed` : ""}
                {latest.usage
                  ? ` · ${Math.round(latest.usage.inputTokens / 1000)}k in / ${Math.round(
                      latest.usage.outputTokens / 1000,
                    )}k out tokens`
                  : ""}
              </span>
            )}
            {inFlight && <span>{latest.totalCount} citations submitted</span>}
            {latest.status === "FAILED" && latest.error && (
              <span className="max-w-md truncate text-destructive" title={latest.error}>
                {latest.error}
              </span>
            )}
            {latest.status === "SUBMITTED" && (
              <Button
                variant="ghost"
                size="sm"
                className="h-7"
                disabled={polling}
                onClick={() => void poll(true)}
              >
                {polling ? <Spinner className="h-3 w-3" /> : <RefreshCw />} Refresh
              </Button>
            )}
            {inFlight && (
              <Button variant="ghost" size="sm" className="h-7" onClick={() => void cancel()}>
                <Ban /> Cancel
              </Button>
            )}
          </div>
        )}
      </div>

      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <Button size="sm" disabled={runDisabled} onClick={() => void start()}>
          {starting || inFlight ? <Spinner className="h-3.5 w-3.5" /> : <Sparkles />}
          {inFlight
            ? "Run in progress…"
            : `Run AI prescreen (${rescore ? unsettled : unscored} citation${(rescore ? unsettled : unscored) === 1 ? "" : "s"})`}
        </Button>
        <label className="flex cursor-pointer items-center gap-1.5 text-xs text-muted-foreground">
          <input
            type="checkbox"
            className="h-3.5 w-3.5 accent-primary"
            checked={rescore}
            disabled={inFlight}
            onChange={(e) => setRescore(e.target.checked)}
          />
          Re-score citations that already have a score
        </label>
      </div>

      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 border-t border-border pt-2">
        <label className="flex cursor-pointer items-center gap-1.5 text-xs">
          <input
            type="checkbox"
            className="h-3.5 w-3.5 accent-primary"
            checked={stage.aiShowScores}
            disabled={savingToggle}
            onChange={(e) => void toggle({ aiShowScores: e.target.checked })}
          />
          Show AI scores to screeners
        </label>
        <label className="flex cursor-pointer items-center gap-1.5 text-xs">
          <input
            type="checkbox"
            className="h-3.5 w-3.5 accent-primary"
            checked={stage.aiRankingEnabled}
            disabled={savingToggle}
            onChange={(e) => void toggle({ aiRankingEnabled: e.target.checked })}
          />
          Order the queue by AI score (highest first)
        </label>
        <span className="text-xs text-muted-foreground">
          Suggestions never decide anything — reviewers still screen every citation.
        </span>
      </div>
    </div>
  );
}
