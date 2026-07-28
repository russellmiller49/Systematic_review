"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import {
  Check,
  CircleHelp,
  EyeOff,
  Inbox,
  Keyboard,
  PartyPopper,
  RefreshCw,
  SkipForward,
  Sparkles,
  StickyNote,
  TriangleAlert,
  X,
} from "lucide-react";
import { toast } from "sonner";
import { api, apiPost, ApiError } from "@/lib/api";
import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { Button, buttonVariants } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { EmptyState, Progress, Skeleton, Spinner } from "@/components/ui/misc";
import { CitationCard } from "@/components/citations/citation-card";
import { ExcludeDialog } from "./exclude-dialog";
import { ShortcutsDialog } from "./shortcuts-dialog";
import type {
  DecisionValue,
  ExclusionReasonOption,
  QueueItem,
  QueueResponse,
  ScreeningKeyword,
  ScreeningStageSummary,
} from "./types";

const DECISION_TOAST: Record<DecisionValue, string> = {
  INCLUDE: "Included",
  EXCLUDE: "Excluded",
  MAYBE: "Marked maybe",
};

const DECISION_BADGE: Record<DecisionValue, "include" | "exclude" | "maybe"> = {
  INCLUDE: "include",
  EXCLUDE: "exclude",
  MAYBE: "maybe",
};

function KeyHint({ label, onColor = false }: { label: string; onColor?: boolean }) {
  return (
    <kbd
      className={cn(
        "ml-1.5 rounded border px-1 font-mono text-[11px] leading-4",
        onColor
          ? "border-white/40 bg-white/15 text-white"
          : "border-border bg-muted text-muted-foreground",
      )}
    >
      {label}
    </kbd>
  );
}

// Keyboard-first queue for one screening stage. Optimistically advances on decide and
// POSTs in the background; a failed POST re-inserts the citation at the front.
export function StageQueue({
  projectId,
  stage,
  keywords,
  highlightsEnabled,
  keywordGroup,
}: {
  projectId: string;
  stage: ScreeningStageSummary;
  keywords: ScreeningKeyword[];
  highlightsEnabled: boolean;
  keywordGroup: string;
}) {
  const queueUrl =
    `/api/projects/${projectId}/screening/stages/${stage.id}/queue` +
    (keywordGroup === "ALL"
      ? ""
      : `?keywordGroup=${encodeURIComponent(keywordGroup)}`);
  const decisionsUrl = `/api/projects/${projectId}/screening/stages/${stage.id}/decisions`;

  const [items, setItems] = useState<QueueItem[] | null>(null);
  // My pending assignments beyond the fetched page (the queue returns up to 25 at a time).
  const [remainingBeyond, setRemainingBeyond] = useState(0);
  const [queueError, setQueueError] = useState(false);
  const [tally, setTally] = useState<Record<DecisionValue, number>>({
    INCLUDE: 0,
    EXCLUDE: 0,
    MAYBE: 0,
  });
  const [noteOpen, setNoteOpen] = useState(false);
  const [note, setNote] = useState("");
  const [excludeOpen, setExcludeOpen] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  const [inFlight, setInFlight] = useState(0);
  const [reasons, setReasons] = useState<ExclusionReasonOption[] | null>(null);

  // Citation ids decided this session (in flight or saved) — keeps refetches from
  // re-adding citations the server may still list as pending.
  const handledRef = useRef<Set<string>>(new Set());
  const inFlightRef = useRef(0);
  const loadingMoreRef = useRef(false);
  const noteRef = useRef<HTMLTextAreaElement | null>(null);

  // ----- queue loading -------------------------------------------------------

  useEffect(() => {
    let cancelled = false;
    api<QueueResponse>(queueUrl)
      .then((resp) => {
        if (cancelled) return;
        setItems(resp.items);
        setRemainingBeyond(Math.max(0, resp.total - resp.items.length));
      })
      .catch((err) => {
        if (cancelled) return;
        toast.error(err instanceof ApiError ? err.message : "Failed to load screening queue");
        setItems([]);
        setQueueError(true);
      });
    return () => {
      cancelled = true;
    };
  }, [queueUrl]);

  // Appends the next queue page, skipping citations already shown or decided here.
  const fetchMore = useCallback(async () => {
    const resp = await api<QueueResponse>(queueUrl);
    setItems((prev) => {
      const current = prev ?? [];
      const currentIds = new Set(current.map((i) => i.citation.id));
      const fresh = resp.items.filter(
        (i) => !currentIds.has(i.citation.id) && !handledRef.current.has(i.citation.id),
      );
      return [...current, ...fresh];
    });
    setRemainingBeyond(Math.max(0, resp.total - resp.items.length));
  }, [queueUrl]);

  // Prefetch the next page as the local queue runs low.
  useEffect(() => {
    if (items === null || items.length > 5 || remainingBeyond <= 0) return;
    if (loadingMoreRef.current) return;
    loadingMoreRef.current = true;
    fetchMore()
      .then(() => setQueueError(false))
      .catch(() => setQueueError(true))
      .finally(() => {
        loadingMoreRef.current = false;
      });
  }, [items, remainingBeyond, fetchMore]);

  function retryLoad() {
    if (loadingMoreRef.current) return;
    loadingMoreRef.current = true;
    setQueueError(false);
    fetchMore()
      .catch((err) => {
        toast.error(err instanceof ApiError ? err.message : "Failed to load screening queue");
        setQueueError(true);
      })
      .finally(() => {
        loadingMoreRef.current = false;
      });
  }

  // Excludes at either stage use the project's applicable reason subgroups.
  useEffect(() => {
    let cancelled = false;
    api<ExclusionReasonOption[]>(
      `/api/projects/${projectId}/exclusion-reasons?stage=${stage.type}`,
    )
      .then((r) => {
        if (!cancelled) setReasons(r);
      })
      .catch(() => {
        if (!cancelled) setReasons([]);
      });
    return () => {
      cancelled = true;
    };
  }, [projectId, stage.type]);

  // ----- deciding ------------------------------------------------------------

  function submitDecision(
    item: QueueItem,
    decision: DecisionValue,
    exclusionReasonId: string | null,
    noteText: string | null,
    exclusionReasonLabel?: string,
  ) {
    // Optimistic advance: drop the citation locally and sync in the background.
    handledRef.current.add(item.citation.id);
    setItems((prev) => (prev ?? []).filter((q) => q.assignmentId !== item.assignmentId));
    setTally((t) => ({ ...t, [decision]: t[decision] + 1 }));
    setNote("");

    inFlightRef.current += 1;
    setInFlight((n) => n + 1);
    const body: {
      citationId: string;
      decision: DecisionValue;
      exclusionReasonId?: string;
      notes?: string;
    } = { citationId: item.citation.id, decision };
    if (exclusionReasonId) body.exclusionReasonId = exclusionReasonId;
    if (noteText) body.notes = noteText;

    apiPost(decisionsUrl, body)
      .then(() => {
        toast.success(
          decision === "EXCLUDE" && exclusionReasonLabel
            ? `Excluded — ${exclusionReasonLabel}`
            : DECISION_TOAST[decision],
          { duration: 1500 },
        );
      })
      .catch((err) => {
        // The decision did NOT save — put the citation back at the front of the queue.
        toast.error(err instanceof ApiError ? err.message : "Failed to save decision");
        handledRef.current.delete(item.citation.id);
        setItems((prev) => [item, ...(prev ?? [])]);
        setTally((t) => ({ ...t, [decision]: Math.max(0, t[decision] - 1) }));
      })
      .finally(() => {
        inFlightRef.current -= 1;
        setInFlight((n) => n - 1);
      });
  }

  function handleDecision(decision: DecisionValue) {
    const current = items?.[0];
    if (!current) return;
    if (decision === "EXCLUDE") {
      // Collect the exclusion subgroup before advancing the queue.
      setExcludeOpen(true);
      return;
    }
    const trimmed = note.trim();
    submitDecision(current, decision, null, trimmed ? trimmed : null);
  }

  function confirmExclude(exclusionReasonId: string, noteText: string) {
    const current = items?.[0];
    setExcludeOpen(false);
    if (!current) return;
    const reason = reasons?.find((item) => item.id === exclusionReasonId);
    submitDecision(
      current,
      "EXCLUDE",
      exclusionReasonId,
      noteText ? noteText : null,
      reason?.label,
    );
  }

  function quickExclude(reason: ExclusionReasonOption) {
    const current = items?.[0];
    if (!current) return;
    const trimmed = note.trim();
    submitDecision(
      current,
      "EXCLUDE",
      reason.id,
      trimmed ? trimmed : null,
      reason.label,
    );
  }

  function handleSkip() {
    setItems((prev) => {
      if (!prev || prev.length < 2) return prev;
      const head = prev[0];
      if (!head) return prev;
      return [...prev.slice(1), head];
    });
    setNote("");
  }

  // ----- keyboard shortcuts ---------------------------------------------------

  const keyHandlerRef = useRef<(e: KeyboardEvent) => void>(() => undefined);
  useEffect(() => {
    keyHandlerRef.current = (e: KeyboardEvent) => {
      if (excludeOpen || helpOpen) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const target = e.target;
      if (
        target instanceof HTMLElement &&
        (target.tagName === "INPUT" ||
          target.tagName === "TEXTAREA" ||
          target.tagName === "SELECT" ||
          target.isContentEditable)
      ) {
        return;
      }
      if (/^[1-9]$/.test(e.key)) {
        const reason = reasons?.[Number(e.key) - 1];
        if (!reason) return;
        quickExclude(reason);
        e.preventDefault();
        return;
      }
      switch (e.key) {
        case "i":
        case "I":
          handleDecision("INCLUDE");
          break;
        case "e":
        case "E":
          handleDecision("EXCLUDE");
          break;
        case "m":
        case "M":
          handleDecision("MAYBE");
          break;
        case "n":
        case "N":
          setNoteOpen((v) => !v);
          break;
        case "j":
        case "J":
        case "ArrowRight":
          handleSkip();
          break;
        case "?":
          setHelpOpen(true);
          break;
        default:
          return;
      }
      e.preventDefault();
    };
  });

  useEffect(() => {
    const listener = (e: KeyboardEvent) => keyHandlerRef.current(e);
    window.addEventListener("keydown", listener);
    return () => window.removeEventListener("keydown", listener);
  }, []);

  // Warn before leaving while decisions are still syncing.
  useEffect(() => {
    const handler = (e: BeforeUnloadEvent) => {
      if (inFlightRef.current > 0) e.preventDefault();
    };
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, []);

  useEffect(() => {
    if (noteOpen) noteRef.current?.focus();
  }, [noteOpen]);

  // ----- render ---------------------------------------------------------------

  if (items === null) {
    return (
      <div className="mx-auto max-w-3xl space-y-4">
        <Skeleton className="h-6 w-48" />
        <Skeleton className="h-1.5 w-full" />
        <Skeleton className="h-80" />
      </div>
    );
  }

  const done = tally.INCLUDE + tally.EXCLUDE + tally.MAYBE;
  const remaining = items.length + remainingBeyond;
  const sessionTotal = done + remaining;
  const current = items[0];

  return (
    <div className="mx-auto max-w-3xl space-y-4">
      {sessionTotal > 0 && (
        <>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex items-center gap-2 text-sm">
              <span className="font-medium tabular-nums">
                {current || remaining > 0
                  ? `Citation ${Math.min(done + 1, sessionTotal)} of ${sessionTotal}`
                  : `${done} screened this session`}
              </span>
              {inFlight > 0 && (
                <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
                  <Spinner className="h-3 w-3" /> saving…
                </span>
              )}
            </div>
            <div className="flex items-center gap-1.5">
              <Badge variant="include">{tally.INCLUDE} included</Badge>
              <Badge variant="exclude">{tally.EXCLUDE} excluded</Badge>
              <Badge variant="maybe">{tally.MAYBE} maybe</Badge>
              <Button
                variant="ghost"
                size="icon"
                className="h-7 w-7"
                aria-label="Keyboard shortcuts"
                title="Keyboard shortcuts (?)"
                onClick={() => setHelpOpen(true)}
              >
                <Keyboard />
              </Button>
            </div>
          </div>
          <Progress value={sessionTotal > 0 ? (done / sessionTotal) * 100 : 0} className="h-1.5" />
        </>
      )}

      {current ? (
        <>
          <CitationCard
            citation={current.citation}
            clampAbstract={false}
            screeningKeywords={keywords}
            highlightScreeningKeywords={highlightsEnabled}
          >
            <div className="space-y-3">
              {current.aiSuggestion && (
                <div className="rounded-md border border-border bg-muted/50 px-3 py-2 text-xs">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <Sparkles className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                    <span className="font-medium tabular-nums">
                      AI likelihood: {current.aiSuggestion.score}/100
                    </span>
                    <Badge variant={DECISION_BADGE[current.aiSuggestion.suggestedDecision]}>
                      suggests {current.aiSuggestion.suggestedDecision.toLowerCase()}
                    </Badge>
                  </div>
                  <details className="mt-1">
                    <summary className="cursor-pointer text-muted-foreground hover:text-foreground">
                      Rationale
                    </summary>
                    <p className="mt-1 text-muted-foreground">{current.aiSuggestion.rationale}</p>
                  </details>
                </div>
              )}
              {current.myDecision && (
                <Badge variant={DECISION_BADGE[current.myDecision.decision]}>
                  Your earlier decision: {current.myDecision.decision.toLowerCase()}
                </Badge>
              )}
              <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
                <Button variant="include" size="lg" onClick={() => handleDecision("INCLUDE")}>
                  <Check /> Include <KeyHint label="i" onColor />
                </Button>
                <Button variant="exclude" size="lg" onClick={() => handleDecision("EXCLUDE")}>
                  <X /> Exclude <KeyHint label="e" onColor />
                </Button>
                <Button variant="maybe" size="lg" onClick={() => handleDecision("MAYBE")}>
                  <CircleHelp /> Maybe <KeyHint label="m" onColor />
                </Button>
              </div>
              {reasons && reasons.length > 0 && (
                <div
                  role="group"
                  aria-label="Quick exclusion reasons"
                  className="rounded-md border border-exclude/20 bg-exclude-muted/50 p-2.5"
                >
                  <div className="mb-2 flex flex-wrap items-center justify-between gap-1.5">
                    <p className="text-xs font-medium text-exclude">
                      Quick exclude by reason
                    </p>
                    <p className="text-[11px] text-muted-foreground">
                      One click, or press 1–9
                    </p>
                  </div>
                  <div className="flex flex-wrap gap-1.5">
                    {reasons.slice(0, 9).map((reason, index) => (
                      <Button
                        key={reason.id}
                        variant="outline"
                        size="sm"
                        className="border-exclude/30 text-exclude hover:bg-exclude-muted"
                        aria-label={`Exclude: ${reason.label} (shortcut ${index + 1})`}
                        onClick={() => quickExclude(reason)}
                      >
                        <X /> {reason.label} <KeyHint label={String(index + 1)} />
                      </Button>
                    ))}
                    <Button
                      variant="ghost"
                      size="sm"
                      className="text-muted-foreground"
                      onClick={() => setExcludeOpen(true)}
                    >
                      {reasons.length > 9 ? "All reasons + note" : "Reason + note"}{" "}
                      <KeyHint label="e" />
                    </Button>
                  </div>
                </div>
              )}
              <div className="flex flex-wrap items-center justify-between gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  aria-pressed={noteOpen}
                  className={cn(noteOpen && "bg-muted")}
                  onClick={() => setNoteOpen((v) => !v)}
                >
                  <StickyNote /> Note <KeyHint label="n" />
                </Button>
                <Button variant="ghost" size="sm" onClick={handleSkip}>
                  <SkipForward /> Skip <KeyHint label="j" />
                </Button>
              </div>
              {noteOpen && (
                <div className="space-y-1">
                  <Textarea
                    ref={noteRef}
                    value={note}
                    onChange={(e) => setNote(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Escape") e.currentTarget.blur();
                    }}
                    placeholder="Optional note, saved with your next decision on this citation…"
                  />
                  <p className="text-xs text-muted-foreground">
                    Press Esc to leave the note and return to shortcuts.
                  </p>
                </div>
              )}
            </div>
          </CitationCard>
          {stage.blinded && (
            <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <EyeOff className="h-3.5 w-3.5 shrink-0" />
              Blinded screening — co-reviewer decisions stay hidden until consensus or conflict.
            </p>
          )}
        </>
      ) : remaining > 0 ? (
        queueError ? (
          <EmptyState
            icon={TriangleAlert}
            title="Couldn't load the rest of your queue"
            description="Your earlier decisions are saved — retry to fetch the remaining citations."
            action={
              <Button variant="outline" size="sm" onClick={retryLoad}>
                <RefreshCw /> Try again
              </Button>
            }
          />
        ) : (
          <div className="flex items-center justify-center gap-2 rounded-lg border border-border bg-card py-14 text-sm text-muted-foreground">
            <Spinner /> Loading more citations…
          </div>
        )
      ) : queueError && done === 0 ? (
        <EmptyState
          icon={TriangleAlert}
          title="Couldn't load your queue"
          description="Something went wrong while fetching your assigned citations."
          action={
            <Button variant="outline" size="sm" onClick={retryLoad}>
              <RefreshCw /> Try again
            </Button>
          }
        />
      ) : (
        <EmptyState
          icon={done > 0 ? PartyPopper : Inbox}
          title={done > 0 ? "Queue clear — nice work" : "No citations waiting for you"}
          description={
            done > 0
              ? `You screened ${done} citation${done === 1 ? "" : "s"} this session. Disagreements, if any, move to adjudication.`
              : "Nothing is assigned to you at this stage right now. Work appears here after an Owner or Admin assigns citations to you."
          }
          action={
            <div className="flex items-center gap-2">
              <Link
                href={`/projects/${projectId}/conflicts`}
                className={buttonVariants({ variant: "outline", size: "sm" })}
              >
                Review conflicts
              </Link>
              <Link
                href={`/projects/${projectId}`}
                className={buttonVariants({ variant: "outline", size: "sm" })}
              >
                Project dashboard
              </Link>
            </div>
          }
        />
      )}

      <ExcludeDialog
        open={excludeOpen}
        onOpenChange={setExcludeOpen}
        projectId={projectId}
        stageType={stage.type}
        reasons={reasons}
        defaultNote={note.trim()}
        onConfirm={confirmExclude}
      />
      <ShortcutsDialog
        open={helpOpen}
        onOpenChange={setHelpOpen}
        stageType={stage.type}
        reasons={reasons}
      />
    </div>
  );
}
