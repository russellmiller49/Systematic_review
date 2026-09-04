"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import {
  Check,
  ChevronLeft,
  ChevronRight,
  CircleHelp,
  EyeOff,
  Inbox,
  Keyboard,
  PartyPopper,
  Plus,
  RefreshCw,
  Sparkles,
  StickyNote,
  TriangleAlert,
  X,
} from "lucide-react";
import { toast } from "sonner";
import { api, apiPatch, apiPost, ApiError } from "@/lib/api";
import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { Button, buttonVariants } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Alert, EmptyState, Progress, Skeleton, Spinner } from "@/components/ui/misc";
import { CitationCard } from "@/components/citations/citation-card";
import { ArticleNavigator } from "./article-navigator";
import { BatchExcludeDialog, ExcludeDialog } from "./exclude-dialog";
import { ShortcutsDialog } from "./shortcuts-dialog";
import type {
  DecisionValue,
  ExclusionReasonOption,
  ScreeningKeyword,
  ScreeningNavigatorFilter,
  ScreeningNavigatorItem,
  ScreeningNavigatorResponse,
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

const NAVIGATOR_PAGE_SIZE = 50;

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

// Keyboard-first reviewer workspace for one stage. The left navigator contains only the
// current reviewer's assigned corpus and exposes aggregate progress, never co-reviewer votes.
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
  const decisionsUrl = `/api/projects/${projectId}/screening/stages/${stage.id}/decisions`;

  const [data, setData] = useState<ScreeningNavigatorResponse | null>(null);
  const [filter, setFilter] = useState<ScreeningNavigatorFilter>("UNDECIDED");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [searchDraft, setSearchDraft] = useState("");
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [navigatorError, setNavigatorError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const [tally, setTally] = useState<Record<DecisionValue, number>>({
    INCLUDE: 0,
    EXCLUDE: 0,
    MAYBE: 0,
  });
  const [noteOpen, setNoteOpen] = useState(false);
  const [note, setNote] = useState("");
  const [abstractEditing, setAbstractEditing] = useState(false);
  const [abstractDraft, setAbstractDraft] = useState("");
  const [abstractSaving, setAbstractSaving] = useState(false);
  const [excludeOpen, setExcludeOpen] = useState(false);
  const [batchExcludeOpen, setBatchExcludeOpen] = useState(false);
  const [batchSelectedIds, setBatchSelectedIds] = useState<Set<string>>(
    () => new Set(),
  );
  const [batchBusy, setBatchBusy] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  const [inFlight, setInFlight] = useState(0);
  const [reasons, setReasons] = useState<ExclusionReasonOption[] | null>(null);

  // Citations currently syncing are omitted from a stale UNDECIDED response.
  const handledRef = useRef<Set<string>>(new Set());
  const inFlightRef = useRef(0);
  const loadGenerationRef = useRef(0);
  const noteRef = useRef<HTMLTextAreaElement | null>(null);

  // ----- navigator loading ---------------------------------------------------

  useEffect(() => {
    const generation = ++loadGenerationRef.current;
    setLoading(true);
    setNavigatorError(null);
    const params = new URLSearchParams({
      status: filter,
      page: String(page),
      limit: String(NAVIGATOR_PAGE_SIZE),
    });
    if (query) params.set("q", query);
    if (keywordGroup !== "ALL") params.set("keywordGroup", keywordGroup);

    api<ScreeningNavigatorResponse>(
      `/api/projects/${projectId}/screening/stages/${stage.id}/navigator?${params}`,
    )
      .then((response) => {
        if (generation !== loadGenerationRef.current) return;
        const items =
          filter === "UNDECIDED"
            ? response.items.filter(
                (item) => !handledRef.current.has(item.citation.id),
              )
            : response.items;
        const next = { ...response, items };
        setData(next);
        if (response.pagination.page !== page) {
          setPage(response.pagination.page);
        }
        setSelectedId((current) =>
          items.some((item) => item.citation.id === current)
            ? current
            : (items[0]?.citation.id ?? null),
        );
      })
      .catch((error) => {
        if (generation !== loadGenerationRef.current) return;
        const message =
          error instanceof ApiError
            ? error.message
            : "Failed to load the screening article list";
        setNavigatorError(message);
        if (data === null) toast.error(message);
      })
      .finally(() => {
        if (generation === loadGenerationRef.current) setLoading(false);
      });
    // `reloadKey` deliberately forces a refresh after a decision or explicit retry.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filter, keywordGroup, page, projectId, query, reloadKey, stage.id]);

  function chooseFilter(next: ScreeningNavigatorFilter) {
    setFilter(next);
    setPage(1);
    setSelectedId(null);
    setNote("");
    setNoteOpen(false);
    setAbstractEditing(false);
    setAbstractDraft("");
    setBatchSelectedIds(new Set());
  }

  function search() {
    setQuery(searchDraft.trim());
    setPage(1);
    setSelectedId(null);
    setBatchSelectedIds(new Set());
  }

  function clearSearch() {
    setSearchDraft("");
    setQuery("");
    setPage(1);
    setSelectedId(null);
    setBatchSelectedIds(new Set());
  }

  function selectArticle(citationId: string) {
    if (citationId === selectedId) return;
    setSelectedId(citationId);
    setNote("");
    setNoteOpen(false);
    setAbstractEditing(false);
    setAbstractDraft("");
  }

  function changePage(nextPage: number) {
    setPage(nextPage);
    setSelectedId(null);
    setNote("");
    setNoteOpen(false);
    setAbstractEditing(false);
    setAbstractDraft("");
    setBatchSelectedIds(new Set());
  }

  // Excludes at either stage use the project's applicable reason subgroups.
  useEffect(() => {
    let cancelled = false;
    api<ExclusionReasonOption[]>(
      `/api/projects/${projectId}/exclusion-reasons?stage=${stage.type}`,
    )
      .then((response) => {
        if (!cancelled) setReasons(response);
      })
      .catch(() => {
        if (!cancelled) setReasons([]);
      });
    return () => {
      cancelled = true;
    };
  }, [projectId, stage.type]);

  const currentIndex =
    data?.items.findIndex((item) => item.citation.id === selectedId) ?? -1;
  const current = currentIndex >= 0 ? (data?.items[currentIndex] ?? null) : null;

  // A server refresh can replace the selection without going through selectArticle.
  // Hydrate the current reviewer's saved note so revisiting or revising an article never
  // makes the note appear lost (or accidentally clears it on the next decision).
  useEffect(() => {
    setAbstractEditing(false);
    setAbstractDraft("");
    setNote(current?.myDecision?.notes ?? "");
    setNoteOpen(Boolean(current?.myDecision?.notes));
  }, [current?.citation.id, current?.myDecision?.notes]);

  async function saveAbstract(event: React.FormEvent) {
    event.preventDefault();
    if (!current || abstractSaving) return;
    const abstract = abstractDraft.trim();
    if (!abstract) return;

    const citationId = current.citation.id;
    setAbstractSaving(true);
    try {
      const response = await apiPatch<{
        citation: { id: string; abstract: string | null };
        aiSuggestionsInvalidated: number;
      }>(`/api/projects/${projectId}/citations/${citationId}`, { abstract });
      setData((previous) =>
        previous
          ? {
              ...previous,
              items: previous.items.map((item) =>
                item.citation.id === citationId
                  ? {
                      ...item,
                      citation: {
                        ...item.citation,
                        abstract: response.citation.abstract,
                      },
                      aiSuggestion: null,
                    }
                  : item,
              ),
            }
          : previous,
      );
      setAbstractEditing(false);
      setAbstractDraft("");
      toast.success("Abstract added");
      if (keywordGroup !== "ALL") setReloadKey((key) => key + 1);
    } catch (error) {
      toast.error(error instanceof ApiError ? error.message : "Failed to add abstract");
      if (
        error instanceof ApiError &&
        (error.code === "CONFLICT" || error.code === "INVALID_STATE")
      ) {
        setReloadKey((key) => key + 1);
      }
    } finally {
      setAbstractSaving(false);
    }
  }

  function navigateRelative(delta: -1 | 1) {
    if (!data || data.items.length === 0) return;
    const index = currentIndex >= 0 ? currentIndex : 0;
    const nextIndex = (index + delta + data.items.length) % data.items.length;
    const next = data.items[nextIndex];
    if (next) selectArticle(next.citation.id);
  }

  // ----- deciding ------------------------------------------------------------

  function submitDecision(
    item: ScreeningNavigatorItem,
    decision: DecisionValue,
    exclusionReasonId: string | null,
    noteText: string | null,
    exclusionReasonLabel?: string,
  ) {
    if (!item.canDecide || handledRef.current.has(item.citation.id)) return;

    const itemIndex =
      data?.items.findIndex((row) => row.citation.id === item.citation.id) ?? -1;
    const nextSelection =
      data?.items[itemIndex + 1]?.citation.id ??
      data?.items[itemIndex - 1]?.citation.id ??
      null;

    handledRef.current.add(item.citation.id);
    setBatchSelectedIds((selected) => {
      if (!selected.has(item.citation.id)) return selected;
      const next = new Set(selected);
      next.delete(item.citation.id);
      return next;
    });
    setTally((currentTally) => ({
      ...currentTally,
      [decision]: currentTally[decision] + 1,
    }));
    setNote("");
    setNoteOpen(false);
    setSelectedId(nextSelection);
    setData((previous) => {
      if (!previous) return previous;
      if (filter === "UNDECIDED") {
        const total = Math.max(0, previous.pagination.total - 1);
        return {
          ...previous,
          summary: {
            ...previous.summary,
            undecided: Math.max(0, previous.summary.undecided - 1),
            decided: previous.summary.decided + (item.myDecision ? 0 : 1),
          },
          pagination: {
            ...previous.pagination,
            total,
            totalPages: Math.max(1, Math.ceil(total / previous.pagination.limit)),
          },
          items: previous.items.filter(
            (row) => row.citation.id !== item.citation.id,
          ),
        };
      }
      return {
        ...previous,
        items: previous.items.map((row) =>
          row.citation.id === item.citation.id
            ? {
                ...row,
                assignmentStatus: "COMPLETED",
                myDecision: { decision, notes: noteText },
                completedReviews: row.myDecision
                  ? row.completedReviews
                  : Math.min(row.requiredReviews, row.completedReviews + 1),
              }
            : row,
        ),
      };
    });

    inFlightRef.current += 1;
    setInFlight((count) => count + 1);
    const body: {
      citationId: string;
      decision: DecisionValue;
      exclusionReasonId?: string;
      notes: string | null;
    } = { citationId: item.citation.id, decision, notes: noteText };
    if (exclusionReasonId) body.exclusionReasonId = exclusionReasonId;

    apiPost(decisionsUrl, body)
      .then(() => {
        toast.success(
          decision === "EXCLUDE" && exclusionReasonLabel
            ? `Excluded — ${exclusionReasonLabel}`
            : DECISION_TOAST[decision],
          { duration: 1500 },
        );
        handledRef.current.delete(item.citation.id);
        setReloadKey((key) => key + 1);
      })
      .catch((error) => {
        handledRef.current.delete(item.citation.id);
        toast.error(error instanceof ApiError ? error.message : "Failed to save decision");
        setSelectedId(item.citation.id);
        setTally((currentTally) => ({
          ...currentTally,
          [decision]: Math.max(0, currentTally[decision] - 1),
        }));
        setReloadKey((key) => key + 1);
      })
      .finally(() => {
        inFlightRef.current -= 1;
        setInFlight((count) => count - 1);
      });
  }

  function handleDecision(decision: DecisionValue) {
    if (!current?.canDecide) return;
    if (decision === "EXCLUDE") {
      setExcludeOpen(true);
      return;
    }
    const trimmed = note.trim();
    submitDecision(current, decision, null, trimmed || null);
  }

  function confirmExclude(exclusionReasonId: string, noteText: string) {
    setExcludeOpen(false);
    if (!current?.canDecide) return;
    const reason = reasons?.find((item) => item.id === exclusionReasonId);
    submitDecision(
      current,
      "EXCLUDE",
      exclusionReasonId,
      noteText || null,
      reason?.label,
    );
  }

  function quickExclude(reason: ExclusionReasonOption) {
    if (!current?.canDecide) return;
    const trimmed = note.trim();
    submitDecision(
      current,
      "EXCLUDE",
      reason.id,
      trimmed || null,
      reason.label,
    );
  }

  function changeBatchSelection(citationId: string, selected: boolean) {
    setBatchSelectedIds((currentSelection) => {
      const next = new Set(currentSelection);
      if (selected) next.add(citationId);
      else next.delete(citationId);
      return next;
    });
  }

  function changeBatchPageSelection(citationIds: string[], selected: boolean) {
    setBatchSelectedIds((currentSelection) => {
      const next = new Set(currentSelection);
      for (const citationId of citationIds) {
        if (selected) next.add(citationId);
        else next.delete(citationId);
      }
      return next;
    });
  }

  async function confirmBatchExclude(exclusionReasonId: string) {
    const citationIds = [...batchSelectedIds];
    if (citationIds.length === 0 || batchBusy) return;

    setBatchBusy(true);
    inFlightRef.current += 1;
    setInFlight((count) => count + 1);
    try {
      const response = await apiPost<{ excluded: number }>(
        `${decisionsUrl}/batch-exclude`,
        { citationIds, exclusionReasonId },
      );
      const reason = reasons?.find((item) => item.id === exclusionReasonId);
      setBatchSelectedIds(new Set());
      setBatchExcludeOpen(false);
      setTally((currentTally) => ({
        ...currentTally,
        EXCLUDE: currentTally.EXCLUDE + response.excluded,
      }));
      toast.success(
        `Excluded ${response.excluded} article${response.excluded === 1 ? "" : "s"}`,
        { description: reason?.label },
      );
      setReloadKey((key) => key + 1);
    } catch (error) {
      setBatchExcludeOpen(false);
      toast.error(
        error instanceof ApiError ? error.message : "Failed to exclude selected articles",
      );
      setReloadKey((key) => key + 1);
    } finally {
      setBatchBusy(false);
      inFlightRef.current -= 1;
      setInFlight((count) => count - 1);
    }
  }

  // ----- keyboard shortcuts -------------------------------------------------

  const keyHandlerRef = useRef<(event: KeyboardEvent) => void>(() => undefined);
  useEffect(() => {
    keyHandlerRef.current = (event: KeyboardEvent) => {
      if (excludeOpen || batchExcludeOpen || helpOpen) return;
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      const target = event.target;
      if (
        target instanceof HTMLElement &&
        (target.tagName === "INPUT" ||
          target.tagName === "TEXTAREA" ||
          target.tagName === "SELECT" ||
          target.isContentEditable)
      ) {
        return;
      }
      if (/^[1-9]$/.test(event.key) && current?.canDecide) {
        const reason = reasons?.[Number(event.key) - 1];
        if (!reason) return;
        quickExclude(reason);
        event.preventDefault();
        return;
      }
      switch (event.key) {
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
          if (!current?.canDecide) return;
          setNoteOpen((value) => !value);
          break;
        case "j":
        case "J":
        case "ArrowRight":
          navigateRelative(1);
          break;
        case "k":
        case "K":
        case "ArrowLeft":
          navigateRelative(-1);
          break;
        case "?":
          setHelpOpen(true);
          break;
        default:
          return;
      }
      event.preventDefault();
    };
  });

  useEffect(() => {
    const listener = (event: KeyboardEvent) => keyHandlerRef.current(event);
    window.addEventListener("keydown", listener);
    return () => window.removeEventListener("keydown", listener);
  }, []);

  useEffect(() => {
    const handler = (event: BeforeUnloadEvent) => {
      if (inFlightRef.current > 0) event.preventDefault();
    };
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, []);

  useEffect(() => {
    if (noteOpen) noteRef.current?.focus();
  }, [noteOpen]);

  // ----- render -------------------------------------------------------------

  if (data === null && loading) {
    return (
      <div className="grid items-start gap-4 lg:grid-cols-[minmax(17rem,21rem)_minmax(0,1fr)]">
        <Skeleton className="h-[34rem] w-full" />
        <div className="space-y-4">
          <Skeleton className="h-6 w-48" />
          <Skeleton className="h-1.5 w-full" />
          <Skeleton className="h-96 w-full" />
        </div>
      </div>
    );
  }

  if (data === null && navigatorError) {
    return (
      <EmptyState
        icon={TriangleAlert}
        title="Couldn't load your article list"
        description={navigatorError}
        action={
          <Button variant="outline" size="sm" onClick={() => setReloadKey((key) => key + 1)}>
            <RefreshCw /> Try again
          </Button>
        }
      />
    );
  }

  if (data === null) return null;

  const done = tally.INCLUDE + tally.EXCLUDE + tally.MAYBE;
  const articlePosition =
    currentIndex >= 0
      ? (data.pagination.page - 1) * data.pagination.limit + currentIndex + 1
      : 0;

  return (
    <>
      <div className="grid items-start gap-4 lg:grid-cols-[minmax(17rem,21rem)_minmax(0,1fr)]">
        <ArticleNavigator
          data={data}
          filter={filter}
          selectedId={selectedId}
          searchDraft={searchDraft}
          keywords={keywords}
          highlightsEnabled={highlightsEnabled}
          loading={loading}
          batchSelectedIds={batchSelectedIds}
          batchBusy={batchBusy}
          onFilterChange={chooseFilter}
          onSelect={selectArticle}
          onBatchSelect={changeBatchSelection}
          onBatchSelectPage={changeBatchPageSelection}
          onBatchExclude={() => setBatchExcludeOpen(true)}
          onSearchDraftChange={setSearchDraft}
          onSearch={search}
          onClearSearch={clearSearch}
          onPageChange={changePage}
        />

        <section aria-label="Selected screening article" className="min-w-0 space-y-4">
          {data.pagination.total > 0 && (
            <>
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex items-center gap-2 text-sm">
                  <span className="font-medium tabular-nums">
                    Citation {articlePosition || 1} of {data.pagination.total}
                  </span>
                  {inFlight > 0 && (
                    <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
                      <Spinner className="h-3 w-3" /> saving…
                    </span>
                  )}
                </div>
                <div className="flex flex-wrap items-center gap-1.5">
                  <Badge variant="include">{tally.INCLUDE} included</Badge>
                  <Badge variant="exclude">{tally.EXCLUDE} excluded</Badge>
                  <Badge variant="maybe">{tally.MAYBE} maybe</Badge>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-7 w-7"
                    aria-label="Previous article"
                    title="Previous article (K or left arrow)"
                    disabled={data.items.length < 2}
                    onClick={() => navigateRelative(-1)}
                  >
                    <ChevronLeft />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-7 w-7"
                    aria-label="Next article"
                    title="Next article (J or right arrow)"
                    disabled={data.items.length < 2}
                    onClick={() => navigateRelative(1)}
                  >
                    <ChevronRight />
                  </Button>
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
              <Progress
                value={
                  data.pagination.total > 0
                    ? (articlePosition / data.pagination.total) * 100
                    : 0
                }
                className="h-1.5"
              />
            </>
          )}

          {navigatorError && (
            <Alert variant="error">
              <span className="flex items-center justify-between gap-3">
                <span>{navigatorError}</span>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setReloadKey((key) => key + 1)}
                >
                  <RefreshCw /> Retry
                </Button>
              </span>
            </Alert>
          )}

          {current ? (
            <>
              <CitationCard
                citation={current.citation}
                clampAbstract={false}
                screeningKeywords={keywords}
                highlightScreeningKeywords={highlightsEnabled}
                missingAbstractContent={
                  abstractEditing ? (
                    <form
                      className="space-y-2 rounded-md border border-dashed border-border bg-muted/30 p-3"
                      onSubmit={saveAbstract}
                    >
                      <label
                        htmlFor={`citation-${current.citation.id}-abstract`}
                        className="text-sm font-medium"
                      >
                        Add abstract
                      </label>
                      <Textarea
                        id={`citation-${current.citation.id}-abstract`}
                        autoFocus
                        required
                        maxLength={50_000}
                        className="min-h-40 bg-background"
                        value={abstractDraft}
                        onChange={(event) => setAbstractDraft(event.target.value)}
                        placeholder="Paste the article abstract here…"
                      />
                      <p className="text-xs text-muted-foreground">
                        This becomes shared, searchable citation metadata for every screener.
                      </p>
                      <div className="flex flex-wrap justify-end gap-2">
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          disabled={abstractSaving}
                          onClick={() => {
                            setAbstractEditing(false);
                            setAbstractDraft("");
                          }}
                        >
                          Cancel
                        </Button>
                        <Button
                          type="submit"
                          size="sm"
                          disabled={abstractSaving || !abstractDraft.trim()}
                        >
                          {abstractSaving && <Spinner />} Save abstract
                        </Button>
                      </div>
                    </form>
                  ) : (
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <p className="text-sm italic text-muted-foreground">
                        No abstract available.
                      </p>
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        onClick={() => setAbstractEditing(true)}
                      >
                        <Plus /> Add abstract
                      </Button>
                    </div>
                  )
                }
              >
                <div className="space-y-3">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="flex flex-wrap items-center gap-1.5">
                      {current.finalOutcome && (
                        <Badge
                          variant={
                            current.finalOutcome === "INCLUDE" ? "include" : "exclude"
                          }
                        >
                          Final outcome: {current.finalOutcome.toLowerCase()}
                        </Badge>
                      )}
                      {current.myDecision && (
                        <Badge variant={DECISION_BADGE[current.myDecision.decision]}>
                          Your decision: {current.myDecision.decision.toLowerCase()}
                        </Badge>
                      )}
                    </div>
                    <span className="text-xs text-muted-foreground">
                      {current.completedReviews} of {current.requiredReviews} required review
                      {current.requiredReviews === 1 ? "" : "s"} submitted
                    </span>
                  </div>

                  {current.aiSuggestion && (
                    <div className="rounded-md border border-border bg-muted/50 px-3 py-2 text-xs">
                      <div className="flex flex-wrap items-center gap-1.5">
                        <Sparkles className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                        <span className="font-medium tabular-nums">
                          AI likelihood: {current.aiSuggestion.score}/100
                        </span>
                        <Badge
                          variant={
                            DECISION_BADGE[current.aiSuggestion.suggestedDecision]
                          }
                        >
                          suggests{" "}
                          {current.aiSuggestion.suggestedDecision.toLowerCase()}
                        </Badge>
                      </div>
                      <details className="mt-1">
                        <summary className="cursor-pointer text-muted-foreground hover:text-foreground">
                          Rationale
                        </summary>
                        <p className="mt-1 text-muted-foreground">
                          {current.aiSuggestion.rationale}
                        </p>
                      </details>
                    </div>
                  )}

                  {current.canDecide ? (
                    <>
                      {current.myDecision && (
                        <p className="text-xs text-muted-foreground">
                          You can revise your decision until this citation receives a final
                          stage outcome.
                        </p>
                      )}
                      <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
                        <Button
                          variant="include"
                          size="lg"
                          onClick={() => handleDecision("INCLUDE")}
                        >
                          <Check /> Include <KeyHint label="i" onColor />
                        </Button>
                        <Button
                          variant="exclude"
                          size="lg"
                          onClick={() => handleDecision("EXCLUDE")}
                        >
                          <X /> Exclude <KeyHint label="e" onColor />
                        </Button>
                        <Button
                          variant="maybe"
                          size="lg"
                          onClick={() => handleDecision("MAYBE")}
                        >
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
                                <X /> {reason.label}{" "}
                                <KeyHint label={String(index + 1)} />
                              </Button>
                            ))}
                            <Button
                              variant="ghost"
                              size="sm"
                              className="text-muted-foreground"
                              onClick={() => setExcludeOpen(true)}
                            >
                              {reasons.length > 9
                                ? "All reasons + note"
                                : "Reason + note"}{" "}
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
                          onClick={() => setNoteOpen((value) => !value)}
                        >
                          <StickyNote /> Note <KeyHint label="n" />
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => navigateRelative(1)}
                        >
                          Next article <KeyHint label="j" />
                        </Button>
                      </div>

                      {noteOpen && (
                        <div className="space-y-1">
                          <Textarea
                            ref={noteRef}
                            value={note}
                            onChange={(event) => setNote(event.target.value)}
                            onKeyDown={(event) => {
                              if (event.key === "Escape") event.currentTarget.blur();
                            }}
                            placeholder="Optional note, saved with your next decision on this citation…"
                          />
                          <p className="text-xs text-muted-foreground">
                            Press Esc to leave the note and return to shortcuts.
                          </p>
                        </div>
                      )}
                    </>
                  ) : (
                    <div className="space-y-3">
                      <Alert>
                        This citation has a final{" "}
                        <strong>{current.finalOutcome?.toLowerCase()}</strong> outcome.
                        Screening decisions are locked unless an authorized user reopens the
                        stage result.
                      </Alert>
                      {current.myDecision?.notes && (
                        <div className="rounded-md border border-border bg-muted/40 px-3 py-2.5">
                          <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                            Your saved note
                          </p>
                          <p className="mt-1 whitespace-pre-wrap text-sm">
                            {current.myDecision.notes}
                          </p>
                        </div>
                      )}
                    </div>
                  )}
                </div>
              </CitationCard>

              {stage.blinded && (
                <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
                  <EyeOff className="h-3.5 w-3.5 shrink-0" />
                  Blinded screening — the article list shows review counts, never a
                  co-reviewer&apos;s choice.
                </p>
              )}
            </>
          ) : loading || inFlight > 0 ? (
            <div className="flex items-center justify-center gap-2 rounded-lg border border-border bg-card py-14 text-sm text-muted-foreground">
              <Spinner /> Updating article list…
            </div>
          ) : (
            <EmptyState
              icon={done > 0 ? PartyPopper : Inbox}
              title={
                filter === "UNDECIDED"
                  ? done > 0
                    ? "Queue clear — nice work"
                    : "No undecided articles in this view"
                  : "No articles match this view"
              }
              description={
                filter === "UNDECIDED"
                  ? done > 0
                    ? `You screened ${done} citation${done === 1 ? "" : "s"} this session.`
                    : "Nothing assigned to you needs a decision at this stage right now."
                  : "Choose another article status or clear the search to keep browsing."
              }
              action={
                <div className="flex items-center gap-2">
                  {filter !== "ALL" && (
                    <Button variant="outline" size="sm" onClick={() => chooseFilter("ALL")}>
                      Show all assigned
                    </Button>
                  )}
                  <Link
                    href={`/projects/${projectId}/conflicts`}
                    className={buttonVariants({ variant: "outline", size: "sm" })}
                  >
                    Review conflicts
                  </Link>
                </div>
              }
            />
          )}
        </section>
      </div>

      <ExcludeDialog
        open={excludeOpen}
        onOpenChange={setExcludeOpen}
        projectId={projectId}
        stageType={stage.type}
        reasons={reasons}
        defaultNote={note.trim()}
        onConfirm={confirmExclude}
      />
      <BatchExcludeDialog
        open={batchExcludeOpen}
        onOpenChange={setBatchExcludeOpen}
        count={batchSelectedIds.size}
        reasons={reasons}
        busy={batchBusy}
        onConfirm={(exclusionReasonId) => {
          void confirmBatchExclude(exclusionReasonId);
        }}
      />
      <ShortcutsDialog
        open={helpOpen}
        onOpenChange={setHelpOpen}
        stageType={stage.type}
        reasons={reasons}
      />
    </>
  );
}
