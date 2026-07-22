"use client";

import { useCallback, useEffect, useState } from "react";
import { Ban, DownloadCloud, RefreshCw } from "lucide-react";
import { toast } from "sonner";
import { api, apiPost, ApiError } from "@/lib/api";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Progress, Spinner } from "@/components/ui/misc";
import type {
  RetrievalRun,
  RetrievalRunListResponse,
  RetrievalRunStatus,
} from "@/components/fulltext/types";

// The poll IS the worker (each poll fetches the next few PDFs server-side), so this
// interval is shorter than the AI panels' 10s.
const POLL_MS = 3_000;

const STATUS_LABEL: Record<RetrievalRunStatus, string> = {
  RUNNING: "Fetching…",
  COMPLETED: "Completed",
  FAILED: "Failed",
  CANCELED: "Canceled",
};

const STATUS_VARIANT: Record<RetrievalRunStatus, "include" | "exclude" | "maybe" | "muted"> = {
  RUNNING: "maybe",
  COMPLETED: "include",
  FAILED: "exclude",
  CANCELED: "muted",
};

// Open-access PDF auto-fetch panel (fulltext.manage holders). Finds legal OA copies via
// Unpaywall + Europe PMC and attaches them to the queue's citations. Paywalled items
// stay manual — that's what the library links on each row are for.
export function AutofetchPanel({
  projectId,
  onChanged,
}: {
  projectId: string;
  onChanged: () => void;
}) {
  const baseUrl = `/api/projects/${projectId}/fulltext/retrieval-runs`;
  const [data, setData] = useState<RetrievalRunListResponse | null>(null);
  const [includeNotRetrieved, setIncludeNotRetrieved] = useState(false);
  const [starting, setStarting] = useState(false);
  const [polling, setPolling] = useState(false);

  const load = useCallback(async () => {
    setData(await api<RetrievalRunListResponse>(baseUrl));
  }, [baseUrl]);

  useEffect(() => {
    load().catch((err) => {
      toast.error(err instanceof ApiError ? err.message : "Failed to load auto-fetch status");
      setData({ runs: [], eligible: 0 });
    });
  }, [load]);

  const latest = data?.runs[0] ?? null;
  const running = latest !== null && latest.status === "RUNNING";

  const poll = useCallback(
    async (manual: boolean) => {
      if (!latest || latest.status !== "RUNNING" || (!manual && polling)) return;
      setPolling(true);
      try {
        const updated = await apiPost<RetrievalRun>(`${baseUrl}/${latest.id}/poll`);
        if (updated.status === "COMPLETED") {
          toast.success(
            `PDF auto-fetch finished — ${updated.retrievedCount} of ${updated.totalCount} found`,
          );
          await load();
          onChanged();
        } else if (updated.status === "FAILED") {
          toast.error(`PDF auto-fetch failed${updated.error ? `: ${updated.error}` : ""}`);
          await load();
        } else {
          setData((prev) =>
            prev
              ? { ...prev, runs: prev.runs.map((r) => (r.id === updated.id ? { ...r, ...updated } : r)) }
              : prev,
          );
          if (updated.retrievedCount > (latest.retrievedCount ?? 0)) onChanged();
        }
      } catch (err) {
        if (manual) {
          toast.error(err instanceof ApiError ? err.message : "Could not advance the run");
        }
      } finally {
        setPolling(false);
      }
    },
    [latest, baseUrl, load, onChanged, polling],
  );

  // Auto-poll while running and the panel is mounted — each poll advances the run.
  useEffect(() => {
    if (!running) return;
    const timer = setInterval(() => {
      if (document.visibilityState === "visible") void poll(false);
    }, POLL_MS);
    return () => clearInterval(timer);
  }, [running, poll]);

  async function start() {
    setStarting(true);
    try {
      await apiPost(baseUrl, { includeNotRetrieved });
      toast.success("PDF auto-fetch started — open-access copies are pulled in while this page is open.");
      setIncludeNotRetrieved(false);
      await load();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Failed to start the auto-fetch run");
    } finally {
      setStarting(false);
    }
  }

  async function cancel() {
    if (!latest) return;
    try {
      await apiPost(`${baseUrl}/${latest.id}/cancel`);
      toast.success("Auto-fetch run canceled");
      await load();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Failed to cancel the run");
    }
  }

  const eligible = data?.eligible ?? 0;
  const startDisabled = data === null || starting || running || (eligible === 0 && !includeNotRetrieved);

  return (
    <div className="mt-6 space-y-3 rounded-lg border border-border bg-card px-4 py-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <DownloadCloud className="h-4 w-4 shrink-0 text-muted-foreground" />
          <span className="text-sm font-medium">Open-access PDF auto-fetch</span>
          <Badge variant="secondary">Unpaywall · Europe PMC</Badge>
        </div>
        {latest && (
          <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
            <Badge variant={STATUS_VARIANT[latest.status]}>{STATUS_LABEL[latest.status]}</Badge>
            <span>
              {latest.processedCount} of {latest.totalCount} checked · {latest.retrievedCount} PDF
              {latest.retrievedCount === 1 ? "" : "s"} found
            </span>
            {latest.status === "FAILED" && latest.error && (
              <span className="max-w-md truncate text-destructive" title={latest.error}>
                {latest.error}
              </span>
            )}
            {running && (
              <>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-7"
                  disabled={polling}
                  onClick={() => void poll(true)}
                >
                  {polling ? <Spinner className="h-3 w-3" /> : <RefreshCw />} Refresh
                </Button>
                <Button variant="ghost" size="sm" className="h-7" onClick={() => void cancel()}>
                  <Ban /> Cancel
                </Button>
              </>
            )}
          </div>
        )}
      </div>

      {running && latest && latest.totalCount > 0 && (
        <Progress value={(latest.processedCount / latest.totalCount) * 100} />
      )}

      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <Button size="sm" disabled={startDisabled} onClick={() => void start()}>
          {starting || running ? <Spinner className="h-3.5 w-3.5" /> : <DownloadCloud />}
          {running
            ? "Fetch in progress…"
            : `Find PDFs (${eligible} citation${eligible === 1 ? "" : "s"} without one)`}
        </Button>
        <label className="flex cursor-pointer items-center gap-1.5 text-xs text-muted-foreground">
          <input
            type="checkbox"
            className="h-3.5 w-3.5 accent-primary"
            checked={includeNotRetrieved}
            disabled={running}
            onChange={(e) => setIncludeNotRetrieved(e.target.checked)}
          />
          Retry citations already marked not retrieved
        </label>
        <span className="text-xs text-muted-foreground">
          Only legal open-access copies are downloaded; use the library links for the rest.
        </span>
      </div>
    </div>
  );
}
