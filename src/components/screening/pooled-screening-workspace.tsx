"use client";

import { useEffect, useRef, useState } from "react";
import { EyeOff, Inbox, Layers3, RefreshCw } from "lucide-react";
import { toast } from "sonner";
import { api, apiPost, ApiError } from "@/lib/api";
import { CitationCard } from "@/components/citations/citation-card";
import { PageHeader, StatCard } from "@/components/layout/page-header";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Alert, EmptyState, Progress, Skeleton } from "@/components/ui/misc";
import { ArticleList } from "./article-navigator";
import { ArticlePosition } from "./article-position";
import { DecisionControls } from "./decision-controls";
import { ExcludeDialog } from "./exclude-dialog";
import { ShortcutsDialog } from "./shortcuts-dialog";
import { useScreeningShortcuts } from "./use-screening-shortcuts";
import {
  QuotaAssignmentsDialog,
  QuotaProgress,
} from "./quota-assignments-dialog";
import { PooledAssignDialog } from "./pooled-assign-dialog";
import type {
  DecisionValue,
  ExclusionReasonOption,
  PooledNavigatorFilter,
  PooledPico,
  PooledQueueResponse,
} from "./types";

export function PooledScreeningWorkspace({
  guidelineId,
  guideline,
  pool,
  showHeader = true,
}: {
  guidelineId: string;
  guideline: { title: string; capabilities: string[] };
  pool: { id: string; name: string; picos: PooledPico[] };
  showHeader?: boolean;
}) {
  const [queue, setQueue] = useState<PooledQueueResponse | null>(null);
  const [filter, setFilter] = useState<PooledNavigatorFilter>("AVAILABLE");
  const [page, setPage] = useState(1);
  const [searchDraft, setSearchDraft] = useState("");
  const [query, setQuery] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const [note, setNote] = useState("");
  const [noteOpen, setNoteOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [excludeOpen, setExcludeOpen] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  const generationRef = useRef(0);
  const busyRef = useRef(false);
  const pageEdgeRef = useRef<"first" | "last">("first");
  const noteRef = useRef<HTMLTextAreaElement | null>(null);
  const canConfigure = guideline.capabilities.includes("screening.configure");
  const canScreen = guideline.capabilities.includes("screening.decide");
  const endpoint = `/api/projects/${guidelineId}/screening/pooled`;
  const refresh = () => setReloadKey((key) => key + 1);

  useEffect(() => {
    if (!canScreen) {
      setLoading(false);
      return;
    }
    const generation = ++generationRef.current;
    setLoading(true);
    const params = new URLSearchParams({
      poolId: pool.id,
      page: String(page),
      limit: "50",
      status: filter,
    });
    if (query) params.set("q", query);
    api<PooledQueueResponse>(`${endpoint}?${params}`)
      .then((response) => {
        if (generation !== generationRef.current) return;
        setQueue(response);
        setError(null);
        setPage(response.pagination.page);
        const selectLast = pageEdgeRef.current === "last";
        setSelectedId((id) =>
          response.items.some((item) => item.id === id)
            ? id
            : ((selectLast
                ? response.items.at(-1)?.id
                : response.items[0]?.id) ?? null),
        );
        pageEdgeRef.current = "first";
      })
      .catch((caught) => {
        if (generation !== generationRef.current) return;
        setError(
          caught instanceof ApiError
            ? caught.message
            : "Failed to load the combined pool",
        );
      })
      .finally(() => {
        if (generation === generationRef.current) setLoading(false);
      });
    return () => {
      generationRef.current++;
    };
  }, [canScreen, endpoint, pool.id, page, filter, query, reloadKey]);

  useEffect(() => {
    if (busy || excludeOpen) return;
    const timer = window.setInterval(() => {
      if (
        document.visibilityState === "visible" &&
        !document.querySelector('[role="dialog"]')
      )
        setReloadKey((key) => key + 1);
    }, 15000);
    return () => window.clearInterval(timer);
  }, [busy, excludeOpen]);

  useEffect(() => {
    const listener = (event: BeforeUnloadEvent) => {
      if (busyRef.current) event.preventDefault();
    };
    window.addEventListener("beforeunload", listener);
    return () => window.removeEventListener("beforeunload", listener);
  }, []);

  const currentIndex =
    queue?.items.findIndex((item) => item.id === selectedId) ?? -1;
  const current = currentIndex < 0 ? null : queue!.items[currentIndex]!;
  const reasons =
    queue?.reasons.map((reason) => ({
      id: reason.label,
      label: reason.label,
    })) ?? [];
  useEffect(() => {
    setNote(current?.myDecision?.notes ?? "");
    setNoteOpen(Boolean(current?.myDecision?.notes));
    setExcludeOpen(false);
  }, [current?.id, current?.myDecision?.notes]);
  useEffect(() => {
    if (noteOpen) noteRef.current?.focus();
  }, [noteOpen]);

  function changePage(next: number, edge: "first" | "last" = "first") {
    if (busyRef.current) return;
    pageEdgeRef.current = edge;
    setSelectedId(null);
    setPage(next);
  }
  function navigateRelative(delta: -1 | 1) {
    if (!queue?.items.length || loading || busyRef.current) return;
    const next = currentIndex + delta;
    if (next < 0 && page > 1) changePage(page - 1, "last");
    else if (next >= queue.items.length && page < queue.pagination.totalPages)
      changePage(page + 1);
    else
      setSelectedId(
        queue.items[(next + queue.items.length) % queue.items.length]!.id,
      );
  }
  function chooseFilter(next: PooledNavigatorFilter) {
    setFilter(next);
    setPage(1);
    setSelectedId(null);
  }
  function search(clear = false) {
    if (clear) setSearchDraft("");
    setQuery(clear ? "" : searchDraft.trim());
    setPage(1);
    setSelectedId(null);
  }

  async function submit(
    decision: DecisionValue,
    exclusionReasonLabel?: string,
    decisionNote = note,
  ) {
    if (!current?.canDecide || busyRef.current || loading) return;
    const item = current;
    busyRef.current = true;
    setBusy(true);
    // Invalidate any pre-decision response so it cannot restore stale queue state.
    generationRef.current++;
    try {
      await apiPost(endpoint, {
        poolId: pool.id,
        citationIds: item.citationIds,
        decision,
        exclusionReasonLabel,
        notes: decisionNote.trim() || null,
      });
      toast.success(
        decision === "MAYBE"
          ? "Marked maybe across linked PICOs"
          : `${decision === "INCLUDE" ? "Included" : "Excluded"} across linked PICOs`,
      );
      if (filter === "AVAILABLE")
        setSelectedId(
          queue?.items[currentIndex + 1]?.id ??
            queue?.items[currentIndex - 1]?.id ??
            null,
        );
      setExcludeOpen(false);
      setLoading(true);
      refresh();
    } catch (caught) {
      const message =
        caught instanceof ApiError
          ? caught.message
          : "Failed to save the pooled decision";
      toast.error(message);
      setExcludeOpen(false);
      // Includes stale capacity, exhausted quota, changed membership and synchronization.
      setLoading(true);
      refresh();
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }
  function handleDecision(decision: DecisionValue) {
    if (decision === "EXCLUDE") {
      if (reasons.length) setExcludeOpen(true);
    } else void submit(decision);
  }
  const quickExclude = (reason: ExclusionReasonOption) => {
    void submit("EXCLUDE", reason.label);
  };
  useScreeningShortcuts({
    blocked: busy || loading || excludeOpen || helpOpen,
    canDecide: Boolean(current?.canDecide),
    reasons,
    onDecision: handleDecision,
    onQuickExclude: quickExclude,
    onToggleNote: () => setNoteOpen((value) => !value),
    onNavigate: navigateRelative,
    onHelp: () => setHelpOpen(true),
  });

  const position =
    queue && currentIndex >= 0
      ? (queue.pagination.page - 1) * queue.pagination.limit + currentIndex + 1
      : 0;
  return (
    <div className="space-y-4">
      {showHeader && (
        <PageHeader
          title={pool.name}
          description="Choose any available abstract. One decision and note apply to every linked PICO."
        />
      )}
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border bg-card p-3">
        <details className="text-sm">
          <summary className="cursor-pointer font-medium">
            <Layers3 className="mr-2 inline h-4 w-4" />
            {pool.name} · {pool.picos.length} PICOs
          </summary>
          <ul className="mt-2 space-y-1 text-muted-foreground">
            {pool.picos.map((pico) => (
              <li key={pico.id}>
                PICO {pico.picoNumber} · {pico.title}
              </li>
            ))}
          </ul>
        </details>
        <div className="flex items-center gap-2">
          {canConfigure && queue?.configuration.reviewersPerCitation === 2 && (
            <QuotaAssignmentsDialog
              endpoint={`${endpoint}/quotas?poolId=${encodeURIComponent(pool.id)}`}
              onSaved={refresh}
            />
          )}
          <Button
            variant="ghost"
            size="sm"
            disabled={busy || loading}
            onClick={refresh}
          >
            <RefreshCw /> Refresh
          </Button>
        </div>
      </div>
      {!canScreen && (
        <Alert variant="warning">
          Your role does not include abstract screening. Ask an Owner or Admin
          for screening access.
        </Alert>
      )}
      {error && <Alert variant="error">{error}</Alert>}
      {!queue && loading && <Skeleton className="h-96" />}
      {queue && (
        <>
          <QuotaProgress
            quota={queue.quota}
            available={queue.summary.available}
          />
          {!queue.quota && (
            <Alert>
              You can continue existing fixed assignments. An Owner or Admin can
              give you a reviewer target to choose from the open queue.
            </Alert>
          )}
          {queue.adminSummary && (
            <details className="rounded-lg border border-border bg-card p-3 text-sm">
              <summary className="cursor-pointer font-medium">
                Pool health
                {queue.adminSummary.needsSynchronization > 0
                  ? ` · Needs synchronization: ${queue.adminSummary.needsSynchronization}`
                  : ""}
              </summary>
              <div className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                <StatCard
                  label="Unique abstracts"
                  value={queue.adminSummary.pooledAbstracts}
                  hint={`${queue.adminSummary.linkedCitationRecords} linked citation records`}
                />
                <StatCard
                  label="Cross-PICO overlaps"
                  value={queue.adminSummary.overlaps}
                />
                <StatCard
                  label="Completed / finalized"
                  value={queue.adminSummary.finalized}
                />
                <StatCard
                  label="All reviews submitted"
                  value={queue.adminSummary.fullyReviewed}
                  hint="Awaiting resolution or decision revision"
                />
                <StatCard
                  label="Needs additional reviews"
                  value={queue.adminSummary.needsAdditionalReviews}
                />
                <StatCard
                  label="Unreviewed"
                  value={queue.adminSummary.unreviewed}
                />
                <StatCard
                  label="Needs synchronization"
                  value={queue.adminSummary.needsSynchronization}
                  hint="Linked decisions, reviewer coverage, or stage results differ"
                />
              </div>
              <p className="mt-3 text-muted-foreground">
                Synchronization problems block pooled decisions until an
                administrator reconciles every linked record. Finalized
                abstracts are counted separately. Use All abstracts to inspect
                affected records.
              </p>
              <details className="mt-3">
                <summary className="cursor-pointer text-muted-foreground">
                  Advanced: fixed assignments
                </summary>
                <p className="my-2 text-muted-foreground">
                  Use only when specific abstracts must be allocated to
                  reviewers. Reviewer quotas are the default for the open queue.
                  Existing fixed assignments remain preserved.
                </p>
                <PooledAssignDialog
                  guidelineId={guidelineId}
                  poolId={pool.id}
                  poolName={pool.name}
                  reviewersPerCitation={
                    queue.configuration.reviewersPerCitation
                  }
                  onAssigned={refresh}
                />
              </details>
            </details>
          )}
          <p className="text-sm text-muted-foreground">
            Choose any article, or use Next to leave it available for later. One
            decision and note apply to every linked PICO.
          </p>
          <div className="grid items-start gap-4 lg:grid-cols-[minmax(17rem,21rem)_minmax(0,1fr)]">
            <ArticleList<PooledNavigatorFilter>
              data={{ pagination: queue.pagination, items: queue.items }}
              filter={filter}
              filterOptions={[
                {
                  value: "AVAILABLE",
                  label: "Available",
                  count: queue.summary.available,
                },
                {
                  value: "MY_REVIEWED",
                  label: "My reviewed",
                  count: queue.summary.myReviewed,
                },
                ...(queue.adminSummary
                  ? [
                      {
                        value: "ALL" as const,
                        label: "All abstracts",
                        count: queue.adminSummary.pooledAbstracts,
                      },
                    ]
                  : []),
              ]}
              selectedId={selectedId}
              searchDraft={searchDraft}
              searchLabel="Search pooled articles"
              keywords={[]}
              highlightsEnabled={false}
              loading={loading || busy}
              onFilterChange={(next) => {
                if (!busyRef.current) chooseFilter(next);
              }}
              onSelect={(id) => {
                if (!busyRef.current && !loading) setSelectedId(id);
              }}
              onSearchDraftChange={setSearchDraft}
              onSearch={() => search()}
              onClearSearch={() => search(true)}
              onPageChange={changePage}
            />
            <section
              aria-label="Selected screening article"
              className="min-w-0 space-y-4"
            >
              {current ? (
                <>
                  <ArticlePosition
                    position={position}
                    total={queue.pagination.total}
                    saving={busy}
                    canNavigate={
                      queue.pagination.total > 1 && !busy && !loading
                    }
                    onNavigate={navigateRelative}
                    onHelp={() => setHelpOpen(true)}
                  />
                  <Progress
                    value={(position / queue.pagination.total) * 100}
                    className="h-1.5"
                  />
                  <CitationCard
                    citation={current.citation}
                    clampAbstract={false}
                  >
                    <div className="space-y-3">
                      <div>
                        <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                          Found in
                        </p>
                        <div className="flex flex-wrap gap-2">
                          {current.picos.map((pico) => (
                            <Badge
                              key={pico.id}
                              variant="secondary"
                              title={pico.researchQuestion ?? pico.title}
                            >
                              PICO {pico.picoNumber} · {pico.title}
                            </Badge>
                          ))}
                        </div>
                      </div>
                      <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
                        {current.myDecision && (
                          <Badge
                            variant={
                              current.myDecision.decision === "INCLUDE"
                                ? "include"
                                : current.myDecision.decision === "EXCLUDE"
                                  ? "exclude"
                                  : "maybe"
                            }
                          >
                            Your decision:{" "}
                            {current.myDecision.decision.toLowerCase()}
                          </Badge>
                        )}
                        <span>
                          {current.completedReviews} of{" "}
                          {current.requiredReviews} required reviews submitted
                        </span>
                      </div>
                      {current.needsSynchronization ? (
                        <Alert variant="warning">
                          This abstract needs synchronization across its linked
                          PICOs before another decision or revision.
                        </Alert>
                      ) : current.finalOutcome ? (
                        <Alert>
                          This abstract has a final{" "}
                          {current.finalOutcome.toLowerCase()} outcome.
                          Screening decisions are locked until every linked
                          stage result is reopened.
                        </Alert>
                      ) : !current.canDecide ? (
                        <Alert>
                          This abstract is currently unavailable for a new
                          decision. Choose another article or ask an
                          administrator to adjust your target.
                        </Alert>
                      ) : (
                        <>
                          {current.myDecision && (
                            <p className="text-xs text-muted-foreground">
                              You can revise this decision until a final stage
                              outcome is recorded. A revision does not consume
                              another quota review.
                            </p>
                          )}
                          <DecisionControls
                            reasons={reasons}
                            note={note}
                            noteOpen={noteOpen}
                            noteRef={noteRef}
                            disabled={busy || loading}
                            onDecision={handleDecision}
                            onExclude={() => setExcludeOpen(true)}
                            onQuickExclude={quickExclude}
                            onToggleNote={() => setNoteOpen((value) => !value)}
                            onNoteChange={setNote}
                            onNext={() => navigateRelative(1)}
                          />
                          {reasons.length === 0 && (
                            <Alert variant="warning">
                              Exclusion requires the same active reason label in
                              every pooled PICO. Ask an administrator to add
                              compatible reasons.
                            </Alert>
                          )}
                        </>
                      )}
                      {!current.canDecide && current.myDecision?.notes && (
                        <div className="rounded-md border border-border p-3">
                          <p className="text-xs font-semibold">
                            Your saved note
                          </p>
                          <p className="mt-1 whitespace-pre-wrap text-sm">
                            {current.myDecision.notes}
                          </p>
                        </div>
                      )}
                    </div>
                  </CitationCard>
                  {queue.configuration.blinded && (
                    <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
                      <EyeOff className="h-3.5 w-3.5" />
                      Blinded screening — review counts never reveal another
                      reviewer&apos;s choice.
                    </p>
                  )}
                </>
              ) : (
                <EmptyState
                  icon={Inbox}
                  title={
                    loading
                      ? "Updating article list…"
                      : "No articles in this view"
                  }
                  description="Choose another filter or clear your search. Your completed reviews remain accessible under My reviewed."
                />
              )}
            </section>
          </div>
          <ExcludeDialog
            open={excludeOpen}
            onOpenChange={setExcludeOpen}
            projectId={guidelineId}
            stageType="TITLE_ABSTRACT"
            reasons={reasons}
            defaultNote={note}
            onConfirm={(label, text) => {
              void submit("EXCLUDE", label, text);
            }}
          />
          <ShortcutsDialog
            open={helpOpen}
            onOpenChange={setHelpOpen}
            stageType="TITLE_ABSTRACT"
            reasons={reasons}
          />
        </>
      )}
    </div>
  );
}
