"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { Layers3, ListChecks, Settings } from "lucide-react";
import { toast } from "sonner";
import { api, ApiError } from "@/lib/api";
import { Badge } from "@/components/ui/badge";
import { Button, buttonVariants } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Alert, EmptyState, Skeleton } from "@/components/ui/misc";
import { PageHeader } from "@/components/layout/page-header";
import { StageQueue } from "./stage-queue";
import { AssignReviewersDialog } from "./assign-dialog";
import { ManageAssignmentsDialog } from "./manage-assignments-dialog";
import { AdminScreeningOverview } from "./admin-screening-overview";
import { PrescreenPanel } from "./prescreen-panel";
import { KeywordToolbar } from "./keyword-toolbar";
import { PooledScreeningWorkspace } from "./pooled-screening-workspace";
import {
  STAGE_LABELS,
  UNMATCHED_KEYWORD_GROUP,
  type GuidelineScreeningConfiguration,
  type ProjectAiStatus,
  type ScreeningKeyword,
  type ScreeningStageSummary,
} from "./types";

// Roles holding `screening.configure` (permission matrix) — who may assign reviewers.
const CONFIGURE_ROLES = new Set(["OWNER", "ADMIN"]);

export function ScreeningWorkspace({ projectId }: { projectId: string }) {
  const [project, setProject] = useState<
    | {
        title: string;
        isGuideline: boolean;
        capabilities: string[];
        parentProject: { id: string; title: string } | null;
        screeningPoolMembership: {
          pool: { id: string; name: string; guidelineId: string };
        } | null;
        subProjects: {
          id: string;
          title: string;
          researchQuestion: string | null;
          status: string;
        }[];
      }
    | null
    | undefined
  >(undefined);

  useEffect(() => {
    let cancelled = false;
    api<NonNullable<typeof project>>(`/api/projects/${projectId}`)
      .then((response) => {
        if (!cancelled) setProject(response);
      })
      .catch(() => {
        if (!cancelled) setProject(null);
      });
    return () => {
      cancelled = true;
    };
  }, [projectId]);

  if (project === undefined) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-8 w-72" />
        <Skeleton className="h-36 w-full" />
        <Skeleton className="h-80 w-full" />
      </div>
    );
  }
  if (project === null) {
    return (
      <EmptyState
        icon={ListChecks}
        title="Screening is unavailable"
        description="The project could not be loaded — check that you still have access."
      />
    );
  }
  if (project.isGuideline) {
    return (
      <GuidelineScreeningWorkspace
        guidelineId={projectId}
        guideline={project}
      />
    );
  }
  if (project.screeningPoolMembership) {
    const pool = project.screeningPoolMembership.pool;
    return (
      <EmptyState
        icon={Layers3}
        title={`Screen through “${pool.name}”`}
        description="This PICO belongs to a saved combined abstract-screening pool, so its title-and-abstract assignments are completed from the guideline workspace."
        action={
          <Link
            className={buttonVariants()}
            href={`/projects/${pool.guidelineId}/screening`}
          >
            Open combined pool
          </Link>
        }
      />
    );
  }
  return <ProjectScreeningWorkspace projectId={projectId} />;
}

function GuidelineScreeningWorkspace({
  guidelineId,
  guideline,
}: {
  guidelineId: string;
  guideline: {
    title: string;
    capabilities: string[];
    subProjects: {
      id: string;
      title: string;
      researchQuestion: string | null;
      status: string;
    }[];
  };
}) {
  const [configuration, setConfiguration] =
    useState<GuidelineScreeningConfiguration | null | undefined>(undefined);
  const [activeQueue, setActiveQueue] = useState<string | null>(null);
  const canConfigure = guideline.capabilities.includes("screening.configure");

  useEffect(() => {
    let cancelled = false;
    api<GuidelineScreeningConfiguration>(
      `/api/projects/${guidelineId}/screening/pool`,
    )
      .then((response) => {
        if (cancelled) return;
        setConfiguration(response);
        setActiveQueue((current) => {
          const available = new Set([
            ...(response.pool ? [`pool:${response.pool.id}`] : []),
            ...response.unpooledPicos.map((pico) => `pico:${pico.id}`),
          ]);
          if (current && available.has(current)) return current;
          return response.pool
            ? `pool:${response.pool.id}`
            : response.unpooledPicos[0]
              ? `pico:${response.unpooledPicos[0].id}`
              : null;
        });
      })
      .catch(() => {
        if (!cancelled) setConfiguration(null);
      });
    return () => {
      cancelled = true;
    };
  }, [guidelineId]);

  const selectedPico = configuration?.unpooledPicos.find(
    (pico) => activeQueue === `pico:${pico.id}`,
  );

  return (
    <div className="space-y-6">
      <PageHeader
        title="Abstract screening"
        description="Work from the saved combined pool or from a PICO that has its own individual queue."
      />

      {configuration === undefined ? (
        <Skeleton className="h-36 w-full" />
      ) : configuration === null ? (
        <Alert variant="error">The guideline screening configuration could not be loaded.</Alert>
      ) : configuration.pool || configuration.unpooledPicos.length > 0 ? (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Screening assignments</CardTitle>
            <CardDescription>
              Pool membership is set by an Owner or Admin. Selecting a queue here never changes
              which PICOs are combined.
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-wrap gap-2">
            {configuration.pool && (
              <Button
                variant={activeQueue === `pool:${configuration.pool.id}` ? "default" : "outline"}
                onClick={() => setActiveQueue(`pool:${configuration.pool!.id}`)}
              >
                <Layers3 /> {configuration.pool.name}
                <Badge variant="secondary">Combined</Badge>
              </Button>
            )}
            {configuration.unpooledPicos.map((pico) => (
              <Button
                key={pico.id}
                variant={activeQueue === `pico:${pico.id}` ? "default" : "outline"}
                onClick={() => setActiveQueue(`pico:${pico.id}`)}
              >
                PICO {pico.picoNumber} · {pico.title}
              </Button>
            ))}
          </CardContent>
        </Card>
      ) : (
        <EmptyState
          icon={ListChecks}
          title="No PICO screening queues yet"
          description="Add PICO questions to this guideline before assigning abstract screening."
        />
      )}

      {configuration && !configuration.pool && canConfigure && (
        <Alert>
          No combined pool is configured. Create and name one in{" "}
          <Link className="font-medium underline" href={`/projects/${guidelineId}/settings`}>
            guideline Settings
          </Link>
          , or keep every PICO as an individual queue.
        </Alert>
      )}

      {configuration?.pool && activeQueue === `pool:${configuration.pool.id}` && (
        <PooledScreeningWorkspace
          guidelineId={guidelineId}
          guideline={guideline}
          pool={configuration.pool}
          showHeader={false}
        />
      )}
      {selectedPico && (
        <div className="space-y-3">
          <div className="flex items-center gap-2">
            <Badge variant="secondary">Individual PICO</Badge>
            <span className="text-sm font-medium">
              PICO {selectedPico.picoNumber} · {selectedPico.title}
            </span>
          </div>
          <ProjectScreeningWorkspace projectId={selectedPico.id} showHeader={false} />
        </div>
      )}
      {configuration && canConfigure && (
        <div className="flex justify-end">
          <Link
            className={buttonVariants({ variant: "outline", size: "sm" })}
            href={`/projects/${guidelineId}/settings`}
          >
            <Settings /> Manage combined pool
          </Link>
        </div>
      )}
    </div>
  );
}

function ProjectScreeningWorkspace({
  projectId,
  showHeader = true,
}: {
  projectId: string;
  showHeader?: boolean;
}) {
  const [stages, setStages] = useState<ScreeningStageSummary[] | null>(null);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [canConfigure, setCanConfigure] = useState(false);
  const [canManageKeywords, setCanManageKeywords] = useState(false);
  const [ai, setAi] = useState<ProjectAiStatus | null>(null);
  const [keywords, setKeywords] = useState<ScreeningKeyword[] | null>(null);
  const [keywordGroup, setKeywordGroup] = useState("ALL");
  const [highlightsEnabled, setHighlightsEnabled] = useState(true);
  const [reloadKey, setReloadKey] = useState(0);
  const [stageReloadKey, setStageReloadKey] = useState(0);

  const loadKeywords = useCallback(async () => {
    try {
      const next = await api<ScreeningKeyword[]>(
        `/api/projects/${projectId}/screening/keywords`,
      );
      setKeywords(next);
      setKeywordGroup((current) =>
        current === "ALL" ||
        current === UNMATCHED_KEYWORD_GROUP ||
        next.some((keyword) => keyword.id === current)
          ? current
          : "ALL",
      );
    } catch {
      setKeywords([]);
    }
  }, [projectId]);

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
  }, [projectId, stageReloadKey]);

  useEffect(() => {
    void loadKeywords();
    const saved = window.localStorage.getItem(`synthesis:keyword-highlights:${projectId}`);
    if (saved !== null) setHighlightsEnabled(saved !== "false");
  }, [loadKeywords, projectId]);

  function refreshAssignments() {
    setStageReloadKey((key) => key + 1);
    setReloadKey((key) => key + 1);
  }

  useEffect(() => {
    api<{ myRoles: string[]; capabilities: string[]; ai: ProjectAiStatus }>(
      `/api/projects/${projectId}`,
    )
      .then((p) => {
        setCanConfigure(p.myRoles.some((r) => CONFIGURE_ROLES.has(r)));
        setCanManageKeywords(p.capabilities.includes("screening.decide"));
        setAi(p.ai);
      })
      .catch(() => {
        setCanConfigure(false);
        setCanManageKeywords(false);
        setAi(null);
      });
  }, [projectId]);

  function changeHighlightsEnabled(enabled: boolean) {
    setHighlightsEnabled(enabled);
    window.localStorage.setItem(
      `synthesis:keyword-highlights:${projectId}`,
      String(enabled),
    );
  }

  return (
    <div>
      {showHeader && (
        <PageHeader
          title="Screening"
          description="Work through your assigned citations — keyboard-first: press ? for shortcuts."
        />
      )}

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
              <StageStrip
                projectId={projectId}
                stage={stage}
                canConfigure={canConfigure}
                onAssignmentsChanged={refreshAssignments}
              />
              {stage.type === "TITLE_ABSTRACT" && canConfigure && ai?.enabled && (
                <PrescreenPanel
                  projectId={projectId}
                  stage={stage}
                  ai={ai}
                  onStageChanged={(patch) =>
                    setStages(
                      (prev) =>
                        prev?.map((s) => (s.id === stage.id ? { ...s, ...patch } : s)) ?? prev,
                    )
                  }
                  onSuggestionsChanged={() => setReloadKey((k) => k + 1)}
                />
              )}
              <KeywordToolbar
                projectId={projectId}
                keywords={keywords}
                canManage={canManageKeywords}
                highlightsEnabled={highlightsEnabled}
                keywordGroup={keywordGroup}
                onHighlightsEnabledChange={changeHighlightsEnabled}
                onKeywordGroupChange={setKeywordGroup}
                onKeywordsChanged={loadKeywords}
              />
              <Tabs defaultValue="my-screening">
                <TabsList>
                  <TabsTrigger value="my-screening">My screening</TabsTrigger>
                  {canConfigure && <TabsTrigger value="admin-view">Admin view</TabsTrigger>}
                </TabsList>
                <TabsContent value="my-screening" className="pt-3">
                  <StageQueue
                    key={`${stage.id}:${reloadKey}:${keywordGroup}`}
                    projectId={projectId}
                    stage={stage}
                    keywords={keywords ?? []}
                    highlightsEnabled={highlightsEnabled}
                    keywordGroup={keywordGroup}
                  />
                </TabsContent>
                {canConfigure && (
                  <TabsContent value="admin-view" className="pt-3">
                    <AdminScreeningOverview
                      key={`${stage.id}:admin:${reloadKey}:${keywordGroup}`}
                      projectId={projectId}
                      stage={stage}
                      keywords={keywords ?? []}
                      highlightsEnabled={highlightsEnabled}
                      keywordGroup={keywordGroup}
                    />
                  </TabsContent>
                )}
              </Tabs>
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
  canConfigure,
  onAssignmentsChanged,
}: {
  projectId: string;
  stage: ScreeningStageSummary;
  canConfigure: boolean;
  onAssignmentsChanged: () => void;
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
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
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
        {canConfigure && (
          <div className="flex flex-wrap gap-2">
            <ManageAssignmentsDialog
              projectId={projectId}
              stage={stage}
              onAssignmentsChanged={onAssignmentsChanged}
            />
            <AssignReviewersDialog
              projectId={projectId}
              stage={stage}
              onAssigned={onAssignmentsChanged}
            />
          </div>
        )}
      </div>
    </div>
  );
}
