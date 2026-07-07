"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { FileSearch, SearchX } from "lucide-react";
import { toast } from "sonner";
import { api, ApiError } from "@/lib/api";
import { cn } from "@/lib/utils";
import { PageHeader, StatCard } from "@/components/layout/page-header";
import { EmptyState, Skeleton } from "@/components/ui/misc";
import { FullTextRow } from "@/components/fulltext/fulltext-row";
import type {
  ExclusionReason,
  FullTextQueueItem,
  RetrievalOutcome,
  ScreeningStageRef,
} from "@/components/fulltext/types";

type RetrievalFilter = "all" | RetrievalOutcome;
type DecisionFilter = "all" | "pending" | "decided";

const RETRIEVAL_FILTERS: { value: RetrievalFilter; label: string }[] = [
  { value: "all", label: "All" },
  { value: "PENDING", label: "Awaiting retrieval" },
  { value: "RETRIEVED", label: "Retrieved" },
  { value: "NOT_RETRIEVED", label: "Not retrieved" },
];

const DECISION_FILTERS: { value: DecisionFilter; label: string }[] = [
  { value: "all", label: "All" },
  { value: "pending", label: "Decision pending" },
  { value: "decided", label: "Decided" },
];

export function FullTextQueueClient({ projectId }: { projectId: string }) {
  const [items, setItems] = useState<FullTextQueueItem[] | null>(null);
  const [ftStageId, setFtStageId] = useState<string | null>(null);
  const [reasons, setReasons] = useState<ExclusionReason[] | null>(null);
  const [retrievalFilter, setRetrievalFilter] = useState<RetrievalFilter>("all");
  const [decisionFilter, setDecisionFilter] = useState<DecisionFilter>("all");

  const loadQueue = useCallback(() => {
    api<FullTextQueueItem[]>(`/api/projects/${projectId}/fulltext/queue`)
      .then(setItems)
      .catch((err) => {
        setItems([]);
        toast.error(
          err instanceof ApiError ? err.message : "Failed to load the full-text queue",
        );
      });
  }, [projectId]);

  useEffect(() => {
    loadQueue();
    api<ScreeningStageRef[]>(`/api/projects/${projectId}/screening/stages`)
      .then((stages) => setFtStageId(stages.find((s) => s.type === "FULL_TEXT")?.id ?? null))
      .catch(() => toast.error("Failed to load screening stages — decision entry is disabled"));
    api<ExclusionReason[]>(`/api/projects/${projectId}/exclusion-reasons?stage=FULL_TEXT`)
      .then(setReasons)
      .catch(() => setReasons([]));
  }, [projectId, loadQueue]);

  const stats = useMemo(() => {
    if (!items) return null;
    return {
      total: items.length,
      retrieved: items.filter((i) => i.retrievalStatus === "RETRIEVED").length,
      notRetrieved: items.filter((i) => i.retrievalStatus === "NOT_RETRIEVED").length,
      decided: items.filter((i) => i.fullTextResult !== null).length,
    };
  }, [items]);

  const visible = useMemo(() => {
    if (!items) return null;
    return items.filter(
      (i) =>
        (retrievalFilter === "all" || i.retrievalStatus === retrievalFilter) &&
        (decisionFilter === "all" ||
          (decisionFilter === "decided") === (i.fullTextResult !== null)),
    );
  }, [items, retrievalFilter, decisionFilter]);

  return (
    <div className="mx-auto w-full max-w-5xl">
      <PageHeader
        title="Full text"
        description="Retrieve full-text reports for citations included at title/abstract, then record full-text screening decisions."
      />

      {stats ? (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <StatCard label="Eligible for full text" value={stats.total} hint="Included at title/abstract" />
          <StatCard label="Retrieved" value={stats.retrieved} />
          <StatCard label="Not retrieved" value={stats.notRetrieved} hint="Counts as PRISMA reports not retrieved" />
          <StatCard label="Decided at full text" value={stats.decided} />
        </div>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {[0, 1, 2, 3].map((i) => (
            <Skeleton key={i} className="h-24" />
          ))}
        </div>
      )}

      {items !== null && items.length > 0 && (
        <div className="mt-6 flex flex-wrap items-center gap-x-6 gap-y-2">
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="text-xs font-medium text-muted-foreground">Retrieval:</span>
            {RETRIEVAL_FILTERS.map((f) => (
              <FilterChip
                key={f.value}
                active={retrievalFilter === f.value}
                onClick={() => setRetrievalFilter(f.value)}
              >
                {f.label} ({retrievalCount(items, f.value)})
              </FilterChip>
            ))}
          </div>
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="text-xs font-medium text-muted-foreground">Decision:</span>
            {DECISION_FILTERS.map((f) => (
              <FilterChip
                key={f.value}
                active={decisionFilter === f.value}
                onClick={() => setDecisionFilter(f.value)}
              >
                {f.label} ({decisionCount(items, f.value)})
              </FilterChip>
            ))}
          </div>
        </div>
      )}

      <div className="mt-6">
        {visible === null ? (
          <div className="space-y-3">
            {[0, 1, 2].map((i) => (
              <Skeleton key={i} className="h-36" />
            ))}
          </div>
        ) : items !== null && items.length === 0 ? (
          <EmptyState
            icon={FileSearch}
            title="No citations awaiting full text"
            description="Citations appear here once they are included at the title/abstract screening stage."
          />
        ) : visible.length === 0 ? (
          <EmptyState
            icon={SearchX}
            title="No citations match the current filters"
            description="Adjust the retrieval or decision filters above to see more of the queue."
          />
        ) : (
          <div className="space-y-3">
            {visible.map((item) => (
              <FullTextRow
                key={item.citation.id}
                projectId={projectId}
                item={item}
                ftStageId={ftStageId}
                exclusionReasons={reasons}
                onChanged={loadQueue}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function retrievalCount(items: FullTextQueueItem[], filter: RetrievalFilter): number {
  if (filter === "all") return items.length;
  return items.filter((i) => i.retrievalStatus === filter).length;
}

function decisionCount(items: FullTextQueueItem[], filter: DecisionFilter): number {
  if (filter === "all") return items.length;
  return items.filter((i) => (filter === "decided") === (i.fullTextResult !== null)).length;
}

function FilterChip({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "rounded-full border px-2.5 py-1 text-xs font-medium transition-colors",
        active
          ? "border-transparent bg-primary text-primary-foreground"
          : "border-border bg-background text-muted-foreground hover:bg-muted",
      )}
    >
      {children}
    </button>
  );
}
