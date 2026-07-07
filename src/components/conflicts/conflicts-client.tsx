"use client";

import { useCallback, useEffect, useState } from "react";
import { CheckCircle2, Gavel, History, ShieldAlert } from "lucide-react";
import { toast } from "sonner";
import { api, ApiError } from "@/lib/api";
import { cn } from "@/lib/utils";
import { PageHeader, StatCard } from "@/components/layout/page-header";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Alert, EmptyState, Skeleton } from "@/components/ui/misc";
import { ConflictItem } from "@/components/conflicts/conflict-item";
import { AdjudicateDialog } from "@/components/conflicts/adjudicate-dialog";
import { ReopenDialog } from "@/components/conflicts/reopen-dialog";
import {
  STAGE_LABELS,
  type ConflictListResponse,
  type ConflictRow,
  type ConflictStatus,
  type EligibilityCriterion,
  type StageType,
} from "@/components/conflicts/types";

const STAGES: StageType[] = ["TITLE_ABSTRACT", "FULL_TEXT"];
const STATUSES: ConflictStatus[] = ["OPEN", "RESOLVED", "VOIDED"];

const EMPTY_STATES: Record<
  ConflictStatus,
  { icon: typeof Gavel; title: string; description: string }
> = {
  OPEN: {
    icon: CheckCircle2,
    title: "No open conflicts",
    description:
      "When reviewers disagree on a citation at this stage, the conflict appears here for adjudication.",
  },
  RESOLVED: {
    icon: Gavel,
    title: "No resolved conflicts",
    description: "Adjudicated conflicts appear here with their final decision and rationale.",
  },
  VOIDED: {
    icon: History,
    title: "No voided conflicts",
    description:
      "Conflicts voided by a reopened result or a duplicate merge appear here for reference.",
  },
};

export function ConflictsClient({ projectId }: { projectId: string }) {
  const [lists, setLists] = useState<Record<StageType, ConflictRow[] | null>>({
    TITLE_ABSTRACT: null,
    FULL_TEXT: null,
  });
  const [criteria, setCriteria] = useState<EligibilityCriterion[]>([]);
  const [forbidden, setForbidden] = useState(false);
  const [stage, setStage] = useState<StageType>("TITLE_ABSTRACT");
  const [status, setStatus] = useState<ConflictStatus>("OPEN");
  const [adjudicating, setAdjudicating] = useState<ConflictRow | null>(null);
  const [reopening, setReopening] = useState<ConflictRow | null>(null);

  // One fetch per stage (all statuses) so counts and chip filters are local.
  const load = useCallback(() => {
    for (const s of STAGES) {
      api<ConflictListResponse>(`/api/projects/${projectId}/conflicts?stage=${s}`)
        .then((res) => {
          setLists((prev) => ({ ...prev, [s]: res.conflicts }));
          setCriteria(res.criteria);
        })
        .catch((err) => {
          if (err instanceof ApiError && err.status === 403) {
            setForbidden(true);
          } else {
            toast.error(`Failed to load ${STAGE_LABELS[s].toLowerCase()} conflicts`);
            setLists((prev) => ({ ...prev, [s]: [] }));
          }
        });
    }
  }, [projectId]);

  useEffect(load, [load]);

  const count = (s: StageType, st: ConflictStatus) =>
    (lists[s] ?? []).filter((c) => c.status === st).length;

  if (forbidden) {
    return (
      <div>
        <PageHeader
          title="Conflicts"
          description="Resolve reviewer disagreements with a final adjudicated decision."
        />
        <Alert variant="warning" className="flex items-start gap-2.5">
          <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0" />
          <span>
            <span className="font-medium">Adjudication rights required.</span> Reviewer
            decisions on conflicting citations stay hidden to preserve blinding. Ask a
            project admin for the adjudicator role to view and resolve conflicts.
          </span>
        </Alert>
      </div>
    );
  }

  const loaded = lists.TITLE_ABSTRACT !== null && lists.FULL_TEXT !== null;
  const activeList = lists[stage];

  return (
    <div>
      <PageHeader
        title="Conflicts"
        description="Resolve reviewer disagreements with a final adjudicated decision."
      />

      <div className="mb-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {loaded ? (
          STAGES.flatMap((s) => [
            <StatCard
              key={`${s}-open`}
              label={`Open · ${STAGE_LABELS[s]}`}
              value={count(s, "OPEN")}
            />,
            <StatCard
              key={`${s}-resolved`}
              label={`Resolved · ${STAGE_LABELS[s]}`}
              value={count(s, "RESOLVED")}
              hint={count(s, "VOIDED") > 0 ? `${count(s, "VOIDED")} voided` : undefined}
            />,
          ])
        ) : (
          <>
            <Skeleton className="h-[92px]" />
            <Skeleton className="h-[92px]" />
            <Skeleton className="h-[92px]" />
            <Skeleton className="h-[92px]" />
          </>
        )}
      </div>

      <Tabs value={stage} onValueChange={(v) => setStage(v as StageType)}>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <TabsList>
            {STAGES.map((s) => (
              <TabsTrigger key={s} value={s}>
                {STAGE_LABELS[s]}
              </TabsTrigger>
            ))}
          </TabsList>
          <div className="flex items-center gap-1.5" role="group" aria-label="Filter by status">
            {STATUSES.map((st) => (
              <button
                key={st}
                type="button"
                onClick={() => setStatus(st)}
                className={cn(
                  "rounded-full border px-3 py-1 text-xs font-medium transition-colors",
                  status === st
                    ? "border-transparent bg-primary text-primary-foreground"
                    : "border-border bg-background text-muted-foreground hover:bg-muted",
                )}
              >
                {st.charAt(0) + st.slice(1).toLowerCase()}
                {activeList !== null && ` (${count(stage, st)})`}
              </button>
            ))}
          </div>
        </div>

        {STAGES.map((s) => (
          <TabsContent key={s} value={s}>
            <StageConflictList
              conflicts={lists[s]}
              status={status}
              onAdjudicate={setAdjudicating}
              onReopen={setReopening}
            />
          </TabsContent>
        ))}
      </Tabs>

      {adjudicating && (
        <AdjudicateDialog
          key={adjudicating.id}
          projectId={projectId}
          conflict={adjudicating}
          criteria={criteria}
          onClose={() => setAdjudicating(null)}
          onDone={() => {
            setAdjudicating(null);
            load();
          }}
        />
      )}
      {reopening && (
        <ReopenDialog
          key={reopening.id}
          projectId={projectId}
          conflict={reopening}
          onClose={() => setReopening(null)}
          onDone={() => {
            setReopening(null);
            load();
          }}
        />
      )}
    </div>
  );
}

function StageConflictList({
  conflicts,
  status,
  onAdjudicate,
  onReopen,
}: {
  conflicts: ConflictRow[] | null;
  status: ConflictStatus;
  onAdjudicate: (c: ConflictRow) => void;
  onReopen: (c: ConflictRow) => void;
}) {
  if (conflicts === null) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-48" />
        <Skeleton className="h-48" />
      </div>
    );
  }

  const filtered = conflicts.filter((c) => c.status === status);
  if (filtered.length === 0) {
    const empty = EMPTY_STATES[status];
    return <EmptyState icon={empty.icon} title={empty.title} description={empty.description} />;
  }

  return (
    <div className="space-y-4">
      {filtered.map((c) => (
        <ConflictItem
          key={c.id}
          conflict={c}
          onAdjudicate={() => onAdjudicate(c)}
          onReopen={() => onReopen(c)}
        />
      ))}
    </div>
  );
}
