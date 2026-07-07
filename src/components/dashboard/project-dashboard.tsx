"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import {
  BarChart3,
  ClipboardList,
  FileSearch,
  FileUp,
  GitMerge,
  History,
  ListChecks,
  Scale,
  Swords,
  Table2,
  type LucideIcon,
} from "lucide-react";
import { toast } from "sonner";
import { api, ApiError } from "@/lib/api";
import { StatCard } from "@/components/layout/page-header";
import { Badge } from "@/components/ui/badge";
import { Card, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Alert, EmptyState, Progress, Skeleton } from "@/components/ui/misc";

interface StageStats {
  type: string;
  assigned: number;
  decided: number;
  openConflicts: number;
  results: { include: number; exclude: number };
}

interface ActivityRow {
  id: string;
  entityType: string;
  action: string;
  createdAt: string;
  actor: { id: string; name: string };
}

interface DashboardData {
  project: { id: string; title: string; reviewType: string; status: string };
  stats: {
    citations: { total: number; active: number; duplicates: number };
    screening: StageStats[];
    fulltext: { sought: number; retrieved: number; notRetrieved: number };
    extraction: { forms: number; completed: number; openConflicts: number };
    rob: { assessments: number; completed: number; openConflicts: number };
    studies: { total: number; inQuantitativeSynthesis: number };
  };
  recentActivity: ActivityRow[];
}

const REVIEW_TYPE_LABELS: Record<string, string> = {
  SYSTEMATIC_REVIEW: "Systematic review",
  SYSTEMATIC_REVIEW_META_ANALYSIS: "SR + meta-analysis",
  DIAGNOSTIC_TEST_ACCURACY: "Diagnostic test accuracy",
  SCOPING_REVIEW: "Scoping review",
  RAPID_REVIEW: "Rapid review",
  LIVING_SYSTEMATIC_REVIEW: "Living systematic review",
  GUIDELINE_EVIDENCE_REVIEW: "Guideline evidence review",
};

const STAGE_LABELS: Record<string, string> = {
  TITLE_ABSTRACT: "Title & abstract",
  FULL_TEXT: "Full text",
};

const STATUS_VARIANTS: Record<string, "muted" | "secondary" | "include"> = {
  PLANNING: "muted",
  SCREENING: "secondary",
  EXTRACTION: "secondary",
  ANALYSIS: "secondary",
  COMPLETED: "include",
  ARCHIVED: "muted",
};

const QUICK_LINKS: { slug: string; label: string; description: string; icon: LucideIcon }[] = [
  {
    slug: "protocol",
    label: "Protocol",
    description: "Define PICO questions, eligibility criteria, and outcomes.",
    icon: ClipboardList,
  },
  {
    slug: "import",
    label: "Import",
    description: "Bring in citations from RIS, BibTeX, CSV, or PubMed files.",
    icon: FileUp,
  },
  {
    slug: "dedup",
    label: "Deduplication",
    description: "Detect and merge duplicate citations before screening.",
    icon: GitMerge,
  },
  {
    slug: "screening",
    label: "Screening",
    description: "Screen titles/abstracts and full texts against your criteria.",
    icon: ListChecks,
  },
  {
    slug: "conflicts",
    label: "Conflicts",
    description: "Adjudicate disagreements between blinded reviewers.",
    icon: Swords,
  },
  {
    slug: "fulltext",
    label: "Full text",
    description: "Track PDF retrieval and attach full-text files.",
    icon: FileSearch,
  },
  {
    slug: "extraction",
    label: "Extraction",
    description: "Extract study data with structured, versioned forms.",
    icon: Table2,
  },
  {
    slug: "rob",
    label: "Risk of bias",
    description: "Assess study quality with configurable RoB tools.",
    icon: Scale,
  },
  {
    slug: "prisma",
    label: "PRISMA",
    description: "Live flow counts, frozen snapshots, and data exports.",
    icon: BarChart3,
  },
];

function stageLabel(type: string): string {
  return STAGE_LABELS[type] ?? type.replace(/_/g, " ").toLowerCase();
}

function ProgressRow({
  label,
  done,
  total,
  unit,
  badges,
}: {
  label: string;
  done: number;
  total: number;
  unit: string;
  badges?: React.ReactNode;
}) {
  const pct = total > 0 ? Math.round((done / total) * 100) : 0;
  return (
    <div className="space-y-1.5">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <p className="text-sm font-medium">{label}</p>
        <p className="text-xs tabular-nums text-muted-foreground">
          {done}/{total} {unit} · {pct}%
        </p>
      </div>
      <Progress value={pct} />
      {badges && <div className="flex flex-wrap gap-1.5 pt-0.5">{badges}</div>}
    </div>
  );
}

export function ProjectDashboard({ projectId }: { projectId: string }) {
  const [data, setData] = useState<DashboardData | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    api<DashboardData>(`/api/projects/${projectId}/dashboard`)
      .then((d) => {
        setData(d);
        setError(null);
      })
      .catch((err) => {
        const message = err instanceof ApiError ? err.message : "Failed to load dashboard";
        setError(message);
        toast.error(message);
      });
  }, [projectId]);

  useEffect(load, [load]);

  const stats = data?.stats;
  const openConflicts = stats
    ? stats.screening.reduce((sum, s) => sum + s.openConflicts, 0) +
      stats.extraction.openConflicts +
      stats.rob.openConflicts
    : 0;

  return (
    <div className="space-y-8">
      {/* Header */}
      <div>
        {data ? (
          <>
            <div className="flex flex-wrap items-center gap-3">
              <h1 className="text-2xl font-semibold tracking-tight">{data.project.title}</h1>
              <Badge variant={STATUS_VARIANTS[data.project.status] ?? "muted"}>
                {data.project.status.toLowerCase()}
              </Badge>
            </div>
            <p className="mt-0.5 text-sm text-muted-foreground">
              {REVIEW_TYPE_LABELS[data.project.reviewType] ?? data.project.reviewType}
            </p>
          </>
        ) : error ? (
          <h1 className="text-2xl font-semibold tracking-tight">Project dashboard</h1>
        ) : (
          <div className="space-y-2">
            <Skeleton className="h-8 w-72" />
            <Skeleton className="h-4 w-44" />
          </div>
        )}
      </div>

      {error && <Alert variant="error">{error}</Alert>}

      {/* Stats */}
      {!error && (
        <section className="space-y-3">
          <h2 className="text-lg font-medium">At a glance</h2>
          {stats === undefined ? (
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
              {Array.from({ length: 4 }, (_, i) => (
                <Skeleton key={i} className="h-28" />
              ))}
            </div>
          ) : (
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
              <StatCard
                label="Citations"
                value={stats.citations.total}
                hint={`${stats.citations.active} active · ${stats.citations.duplicates} duplicates`}
              />
              {stats.screening.map((s) => (
                <StatCard
                  key={s.type}
                  label={`${stageLabel(s.type)} screening`}
                  value={`${s.decided}/${s.assigned}`}
                  hint={`${s.results.include} included · ${s.results.exclude} excluded`}
                />
              ))}
              <StatCard
                label="Open conflicts"
                value={openConflicts}
                hint="Across screening, extraction, and RoB"
              />
              <StatCard
                label="Full text"
                value={`${stats.fulltext.retrieved}/${stats.fulltext.sought}`}
                hint={`retrieved · ${stats.fulltext.notRetrieved} not retrievable`}
              />
              <StatCard
                label="Extraction"
                value={`${stats.extraction.completed}/${stats.extraction.forms}`}
                hint="forms completed"
              />
              <StatCard
                label="Risk of bias"
                value={`${stats.rob.completed}/${stats.rob.assessments}`}
                hint="assessments completed"
              />
              <StatCard
                label="Studies"
                value={stats.studies.total}
                hint={`${stats.studies.inQuantitativeSynthesis} in quantitative synthesis`}
              />
            </div>
          )}
        </section>
      )}

      {/* Pipeline progress */}
      {!error && (
        <section className="space-y-3">
          <h2 className="text-lg font-medium">Pipeline progress</h2>
          {stats === undefined ? (
            <Skeleton className="h-48" />
          ) : (
            <div className="space-y-5 rounded-lg border border-border bg-card p-5">
              {stats.screening.length === 0 ? (
                <p className="text-sm text-muted-foreground">
                  No screening stages yet — set them up in{" "}
                  <Link href={`/projects/${projectId}/screening`} className="text-primary hover:underline">
                    Screening
                  </Link>{" "}
                  to start reviewing citations.
                </p>
              ) : (
                stats.screening.map((s) => (
                  <ProgressRow
                    key={s.type}
                    label={`${stageLabel(s.type)} screening`}
                    done={s.decided}
                    total={s.assigned}
                    unit="decisions"
                    badges={
                      <>
                        <Badge variant="include">{s.results.include} included</Badge>
                        <Badge variant="exclude">{s.results.exclude} excluded</Badge>
                        {s.openConflicts > 0 && (
                          <Badge variant="maybe">{s.openConflicts} open conflicts</Badge>
                        )}
                      </>
                    }
                  />
                ))
              )}
              <ProgressRow
                label="Full-text retrieval"
                done={stats.fulltext.retrieved}
                total={stats.fulltext.sought}
                unit="reports"
                badges={
                  stats.fulltext.notRetrieved > 0 ? (
                    <Badge variant="maybe">{stats.fulltext.notRetrieved} not retrievable</Badge>
                  ) : undefined
                }
              />
              <ProgressRow
                label="Data extraction"
                done={stats.extraction.completed}
                total={stats.extraction.forms}
                unit="forms"
                badges={
                  stats.extraction.openConflicts > 0 ? (
                    <Badge variant="maybe">{stats.extraction.openConflicts} open conflicts</Badge>
                  ) : undefined
                }
              />
              <ProgressRow
                label="Risk of bias"
                done={stats.rob.completed}
                total={stats.rob.assessments}
                unit="assessments"
                badges={
                  stats.rob.openConflicts > 0 ? (
                    <Badge variant="maybe">{stats.rob.openConflicts} open conflicts</Badge>
                  ) : undefined
                }
              />
            </div>
          )}
        </section>
      )}

      {/* Quick links */}
      <section className="space-y-3">
        <h2 className="text-lg font-medium">Workspace</h2>
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {QUICK_LINKS.map(({ slug, label, description, icon: Icon }, i) => (
            <Link key={slug} href={`/projects/${projectId}/${slug}`}>
              <Card className="h-full transition-shadow hover:shadow-md">
                <CardHeader>
                  <div className="flex items-center gap-2.5">
                    <Icon className="h-4 w-4 text-muted-foreground" />
                    <CardTitle className="text-base leading-snug">{label}</CardTitle>
                    <span className="ml-auto text-xs tabular-nums text-muted-foreground/60">
                      {i + 1}
                    </span>
                  </div>
                  <CardDescription>{description}</CardDescription>
                </CardHeader>
              </Card>
            </Link>
          ))}
        </div>
      </section>

      {/* Recent activity */}
      {!error && (
        <section className="space-y-3">
          <h2 className="text-lg font-medium">Recent activity</h2>
          {data === null ? (
            <Skeleton className="h-32" />
          ) : data.recentActivity.length === 0 ? (
            <EmptyState
              icon={History}
              title="No activity to show"
              description="Recent project events appear here for roles with audit access."
            />
          ) : (
            <div className="divide-y divide-border rounded-lg border border-border bg-card">
              {data.recentActivity.map((ev) => (
                <div key={ev.id} className="flex items-start justify-between gap-3 px-4 py-2.5">
                  <div className="min-w-0">
                    <p className="truncate text-sm">
                      <span className="font-medium">{ev.actor.name}</span>{" "}
                      <span className="text-muted-foreground">{ev.action}</span>
                    </p>
                    <p className="mt-0.5 text-xs text-muted-foreground">{ev.entityType}</p>
                  </div>
                  <p className="shrink-0 text-xs text-muted-foreground">
                    {new Date(ev.createdAt).toLocaleString()}
                  </p>
                </div>
              ))}
            </div>
          )}
        </section>
      )}
    </div>
  );
}
