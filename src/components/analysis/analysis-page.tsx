"use client";

// /projects/[projectId]/analysis — meta-analysis hub.
// Left: the project's analysis outcomes (define + select). Right: the selected
// outcome's field mappings and live results (per-study table + forest plot).
// Results are recomputed server-side from extraction data on every fetch;
// ResultsSection polls to keep the plot live while extraction proceeds elsewhere.

import { useCallback, useEffect, useState } from "react";
import { CheckCircle2, CircleDashed, Lock, Pencil, Plus, Sigma } from "lucide-react";
import { toast } from "sonner";
import { api, ApiError } from "@/lib/api";
import { cn } from "@/lib/utils";
import { PageHeader } from "@/components/layout/page-header";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { EmptyState, Skeleton } from "@/components/ui/misc";
import type { Template } from "@/components/extraction/types";
import { MappingEditor } from "./mapping-editor";
import { OutcomeDialog, type OutcomeDialogState } from "./outcome-dialog";
import { ResultsSection } from "./results-table";
import {
  DIRECTION_LABELS,
  hasCap,
  MEASURE_LABELS,
  type AnalysisOutcomeRow,
  type ProtocolOutcomeOption,
} from "./types";

interface ProjectResponse {
  myRoles: string[];
}

interface ProtocolResponse {
  outcomes: ProtocolOutcomeOption[];
}

export function AnalysisClient({ projectId }: { projectId: string }) {
  const [roles, setRoles] = useState<string[] | null>(null);
  const [outcomes, setOutcomes] = useState<AnalysisOutcomeRow[] | null>(null);
  const [forbidden, setForbidden] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [templates, setTemplates] = useState<Template[] | null>(null);
  const [protocolOutcomes, setProtocolOutcomes] = useState<ProtocolOutcomeOption[]>([]);
  const [dialog, setDialog] = useState<OutcomeDialogState | null>(null);

  const loadOutcomes = useCallback(() => {
    api<AnalysisOutcomeRow[]>(`/api/projects/${projectId}/analysis/outcomes`)
      .then((rows) => {
        setOutcomes(rows);
        setForbidden(false);
      })
      .catch((err) => {
        setOutcomes([]);
        if (err instanceof ApiError && err.status === 403) setForbidden(true);
        else toast.error("Failed to load analysis outcomes");
      });
  }, [projectId]);

  useEffect(() => {
    api<ProjectResponse>(`/api/projects/${projectId}`)
      .then((p) => setRoles(p.myRoles))
      .catch(() => setRoles([]));
    // Templates and protocol outcomes feed the mapping editor / anchor picker;
    // a failure degrades those pickers rather than blocking the page.
    api<Template[]>(`/api/projects/${projectId}/extraction/templates`)
      .then(setTemplates)
      .catch(() => setTemplates([]));
    api<ProtocolResponse>(`/api/projects/${projectId}/protocol`)
      .then((p) => setProtocolOutcomes(p.outcomes))
      .catch(() => setProtocolOutcomes([]));
    loadOutcomes();
  }, [projectId, loadOutcomes]);

  const canManage = hasCap(roles, "analysis.manage");
  const deniedByRole = roles !== null && !hasCap(roles, "analysis.view");

  const selected =
    outcomes === null ? null : (outcomes.find((o) => o.id === selectedId) ?? outcomes[0] ?? null);

  if (deniedByRole || forbidden) {
    return (
      <div>
        <PageHeader
          title="Analysis"
          description="Define outcomes, map extracted numbers to statistical roles, and watch pooled effects update as extraction proceeds."
        />
        <EmptyState
          icon={Lock}
          title="You don't have access to analysis results"
          description="Ask a project owner or admin for an analysis-capable role if you need to see pooled results."
        />
      </div>
    );
  }

  return (
    <div>
      <PageHeader
        title="Analysis"
        description="Define outcomes, map extracted numbers to statistical roles, and watch pooled effects update as extraction proceeds."
      />
      <div className="flex flex-col gap-6 lg:flex-row lg:items-start">
        <aside className="w-full shrink-0 space-y-3 lg:w-72">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-medium text-muted-foreground">Outcomes</h2>
            {canManage && (
              <Button size="sm" onClick={() => setDialog({ mode: "create" })}>
                <Plus /> New outcome
              </Button>
            )}
          </div>
          {outcomes === null ? (
            <Skeleton className="h-40" />
          ) : outcomes.length === 0 ? (
            <EmptyState
              icon={Sigma}
              title="No analysis outcomes yet"
              description={
                canManage
                  ? "Create an outcome, pick an effect measure, then map extraction fields to its statistical roles."
                  : "An admin or statistician defines analysis outcomes here."
              }
            />
          ) : (
            outcomes.map((o) => (
              <button
                key={o.id}
                type="button"
                onClick={() => setSelectedId(o.id)}
                className={cn(
                  "w-full rounded-lg border border-border bg-card p-3 text-left transition-colors hover:bg-muted/50",
                  selected?.id === o.id && "border-primary ring-1 ring-primary",
                )}
              >
                <span className="block truncate font-medium">{o.name}</span>
                <span className="mt-1.5 flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
                  <Badge variant="secondary" className="px-1.5 py-0 text-[10px]">
                    {o.measure}
                  </Badge>
                  {o.timepoint && <span>{o.timepoint}</span>}
                  <span className="grow" />
                  {o.mappingComplete ? (
                    <span className="inline-flex items-center gap-1 text-include">
                      <CheckCircle2 className="h-3.5 w-3.5" /> Mapped
                    </span>
                  ) : (
                    <span className="inline-flex items-center gap-1 text-maybe">
                      <CircleDashed className="h-3.5 w-3.5" /> Mapping needed
                    </span>
                  )}
                </span>
              </button>
            ))
          )}
        </aside>

        <main className="min-w-0 flex-1 space-y-6">
          {selected === null ? (
            outcomes !== null && (
              <EmptyState
                title="Select an outcome"
                description="Pick an outcome on the left — or create one — to map fields and see pooled results."
              />
            )
          ) : (
            <>
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <h2 className="text-lg font-semibold">{selected.name}</h2>
                  <p className="text-sm text-muted-foreground">
                    {MEASURE_LABELS[selected.measure]}
                    {selected.timepoint ? ` · ${selected.timepoint}` : ""} ·{" "}
                    {DIRECTION_LABELS[selected.direction]}
                  </p>
                </div>
                {canManage && (
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => setDialog({ mode: "edit", outcome: selected })}
                  >
                    <Pencil /> Edit
                  </Button>
                )}
              </div>
              <MappingEditor
                projectId={projectId}
                outcome={selected}
                templates={templates}
                canManage={canManage}
                onSaved={loadOutcomes}
              />
              <ResultsSection projectId={projectId} outcome={selected} canManage={canManage} />
            </>
          )}
        </main>
      </div>

      <OutcomeDialog
        projectId={projectId}
        state={dialog}
        protocolOutcomes={protocolOutcomes}
        onClose={() => setDialog(null)}
        onSaved={(row) => {
          setDialog(null);
          setSelectedId(row.id);
          loadOutcomes();
        }}
        onDeleted={(id) => {
          setDialog(null);
          if (selectedId === id) setSelectedId(null);
          loadOutcomes();
        }}
      />
    </div>
  );
}
