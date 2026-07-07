"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { ListChecks } from "lucide-react";
import { toast } from "sonner";
import { api, ApiError } from "@/lib/api";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { EmptyState, Skeleton } from "@/components/ui/misc";
import { PageHeader } from "@/components/layout/page-header";
import { StageQueue } from "./stage-queue";
import { STAGE_LABELS, type ScreeningStageSummary } from "./types";

export function ScreeningWorkspace({ projectId }: { projectId: string }) {
  const [stages, setStages] = useState<ScreeningStageSummary[] | null>(null);
  const [activeId, setActiveId] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    api<ScreeningStageSummary[]>(`/api/projects/${projectId}/screening/stages`)
      .then((s) => {
        if (cancelled) return;
        setStages(s);
        setActiveId((cur) => cur ?? s[0]?.id ?? null);
      })
      .catch((err) => {
        if (cancelled) return;
        toast.error(err instanceof ApiError ? err.message : "Failed to load screening stages");
        setStages([]);
      });
    return () => {
      cancelled = true;
    };
  }, [projectId]);

  return (
    <div>
      <PageHeader
        title="Screening"
        description="Work through your assigned citations — keyboard-first: press ? for shortcuts."
      />

      {stages === null ? (
        <div className="space-y-4">
          <Skeleton className="h-9 w-72" />
          <Skeleton className="h-14 w-full" />
          <Skeleton className="h-80 w-full" />
        </div>
      ) : stages.length === 0 ? (
        <EmptyState
          icon={ListChecks}
          title="Screening is unavailable"
          description="The screening stages could not be loaded — check that you still have access to this project."
        />
      ) : (
        <Tabs value={activeId ?? undefined} onValueChange={setActiveId}>
          <TabsList>
            {stages.map((stage) => (
              <TabsTrigger key={stage.id} value={stage.id}>
                {STAGE_LABELS[stage.type]}
              </TabsTrigger>
            ))}
          </TabsList>
          {stages.map((stage) => (
            <TabsContent key={stage.id} value={stage.id} className="space-y-6">
              <StageStrip projectId={projectId} stage={stage} />
              <StageQueue key={stage.id} projectId={projectId} stage={stage} />
            </TabsContent>
          ))}
        </Tabs>
      )}
    </div>
  );
}

// Stage configuration badges + team-level progress (my personal progress lives in the queue).
function StageStrip({
  projectId,
  stage,
}: {
  projectId: string;
  stage: ScreeningStageSummary;
}) {
  const p = stage.progress;
  return (
    <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 rounded-lg border border-border bg-card px-4 py-3">
      <div className="flex flex-wrap items-center gap-1.5">
        <Badge variant="secondary">
          {stage.reviewersPerCitation === 1
            ? "Single reviewer"
            : `Dual review · ${stage.reviewersPerCitation} per citation`}
        </Badge>
        <Badge variant={stage.blinded ? "default" : "muted"}>
          {stage.blinded ? "Blinded" : "Unblinded"}
        </Badge>
        {stage.maybeGeneratesConflict && <Badge variant="maybe">Maybe raises conflicts</Badge>}
      </div>
      <p className="text-xs text-muted-foreground">
        Team: {p.decidedCitations} of {p.assignedCitations} citations decided ·{" "}
        {p.results.included} included · {p.results.excluded} excluded ·{" "}
        {p.openConflicts > 0 ? (
          <Link
            href={`/projects/${projectId}/conflicts`}
            className="font-medium text-foreground underline-offset-2 hover:underline"
          >
            {p.openConflicts} open conflict{p.openConflicts === 1 ? "" : "s"}
          </Link>
        ) : (
          "no open conflicts"
        )}
      </p>
    </div>
  );
}
