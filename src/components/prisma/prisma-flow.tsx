"use client";

import { useCallback, useEffect, useState } from "react";
import { ArrowDown, Camera, Download, Eye, FileDown, FileX, RefreshCw } from "lucide-react";
import { toast } from "sonner";
import { api, apiPost, ApiError } from "@/lib/api";
import { cn } from "@/lib/utils";
import { PageHeader } from "@/components/layout/page-header";
import { Button, buttonVariants } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import { EmptyState, Skeleton, Spinner } from "@/components/ui/misc";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

interface PrismaCountRow {
  key: string;
  label: string;
  value: number;
  breakdown?: Record<string, number>;
}

interface PrismaReport {
  counts: PrismaCountRow[];
  computedAt: string;
}

interface SnapshotListRow {
  id: string;
  label: string;
  createdAt: string;
  createdBy: { id: string; name: string };
}

interface SnapshotCountRow {
  id: string;
  key: string;
  label: string;
  value: number;
  breakdown?: Record<string, number> | null;
}

interface SnapshotDetail {
  id: string;
  label: string;
  createdAt: string;
  createdBy: { id: string; name: string };
  counts: SnapshotCountRow[];
}

interface ExportJobRow {
  id: string;
  kind: string;
  format: string;
  status: string;
  error?: string | null;
  createdAt: string;
  requestedBy: { id: string; name: string };
}

const STAGE_GROUPS: { title: string; keys: string[] }[] = [
  { title: "Identification", keys: ["records_identified", "duplicates_removed"] },
  {
    title: "Screening",
    keys: ["records_screened", "records_excluded_ta", "reports_sought", "reports_not_retrieved"],
  },
  { title: "Eligibility", keys: ["reports_assessed", "reports_excluded"] },
  {
    title: "Included",
    keys: ["studies_included", "reports_included", "studies_in_quantitative_synthesis"],
  },
];

const KEY_ORDER = STAGE_GROUPS.flatMap((g) => g.keys);

function keyIndex(key: string): number {
  const i = KEY_ORDER.indexOf(key);
  return i === -1 ? KEY_ORDER.length : i;
}

const EXPORT_KINDS: { value: string; label: string }[] = [
  { value: "PRISMA", label: "PRISMA counts" },
  { value: "CITATIONS", label: "Citations" },
  { value: "SCREENING", label: "Screening decisions" },
  { value: "EXTRACTION", label: "Extraction data" },
  { value: "ROB", label: "Risk of bias" },
  { value: "AUDIT", label: "Audit trail" },
  { value: "FULL", label: "Full project (JSON only)" },
];

const EXPORT_KIND_LABELS: Record<string, string> = Object.fromEntries(
  EXPORT_KINDS.map((k) => [k.value, k.label]),
);

function sortedBreakdown(breakdown: Record<string, number>): [string, number][] {
  return Object.entries(breakdown).sort((a, b) => b[1] - a[1]);
}

const MAX_INLINE_BREAKDOWN = 4;

function CountBox({ row }: { row: PrismaCountRow }) {
  const entries = row.breakdown ? sortedBreakdown(row.breakdown) : [];
  const shown = entries.slice(0, MAX_INLINE_BREAKDOWN);
  const hidden = entries.length - shown.length;
  return (
    <div className="rounded-lg border border-border bg-card p-4">
      <p className="text-sm text-muted-foreground">{row.label}</p>
      <p className="mt-1 text-2xl font-semibold tabular-nums">{row.value.toLocaleString()}</p>
      {shown.length > 0 && (
        <div className="mt-2 space-y-0.5 border-t border-border pt-2">
          {shown.map(([label, n]) => (
            <div
              key={label}
              className="flex items-center justify-between gap-2 text-xs text-muted-foreground"
            >
              <span className="truncate" title={label}>
                {label}
              </span>
              <span className="shrink-0 tabular-nums">{n.toLocaleString()}</span>
            </div>
          ))}
          {hidden > 0 && <p className="text-xs text-muted-foreground/70">+{hidden} more</p>}
        </div>
      )}
    </div>
  );
}

export function PrismaFlow({ projectId }: { projectId: string }) {
  const [report, setReport] = useState<PrismaReport | null>(null);
  const [snapshots, setSnapshots] = useState<SnapshotListRow[] | null>(null);
  const [exportJobs, setExportJobs] = useState<ExportJobRow[] | null>(null);
  const [exportsForbidden, setExportsForbidden] = useState(false);

  const [snapOpen, setSnapOpen] = useState(false);
  const [snapLabel, setSnapLabel] = useState("");
  const [snapBusy, setSnapBusy] = useState(false);

  const [detailId, setDetailId] = useState<string | null>(null);
  const [detail, setDetail] = useState<SnapshotDetail | null>(null);

  const [exportKind, setExportKind] = useState("PRISMA");
  const [exportFormat, setExportFormat] = useState("CSV");
  const [exporting, setExporting] = useState(false);

  const loadReport = useCallback(() => {
    api<PrismaReport>(`/api/projects/${projectId}/prisma`)
      .then(setReport)
      .catch((err) =>
        toast.error(err instanceof ApiError ? err.message : "Failed to load PRISMA counts"),
      );
  }, [projectId]);

  const loadSnapshots = useCallback(() => {
    api<SnapshotListRow[]>(`/api/projects/${projectId}/prisma/snapshots`)
      .then(setSnapshots)
      .catch(() => setSnapshots([]));
  }, [projectId]);

  const loadExports = useCallback(() => {
    api<ExportJobRow[]>(`/api/projects/${projectId}/exports`)
      .then((jobs) => {
        setExportJobs(jobs);
        setExportsForbidden(false);
      })
      .catch((err) => {
        setExportJobs([]);
        if (err instanceof ApiError && err.status === 403) setExportsForbidden(true);
      });
  }, [projectId]);

  useEffect(() => {
    loadReport();
    loadSnapshots();
    loadExports();
  }, [loadReport, loadSnapshots, loadExports]);

  // Fetch snapshot detail when the view dialog opens.
  useEffect(() => {
    if (detailId === null) {
      setDetail(null);
      return;
    }
    let cancelled = false;
    api<SnapshotDetail>(`/api/projects/${projectId}/prisma/snapshots/${detailId}`)
      .then((d) => {
        if (!cancelled) setDetail(d);
      })
      .catch((err) => {
        if (!cancelled) {
          toast.error(err instanceof ApiError ? err.message : "Failed to load snapshot");
          setDetailId(null);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [detailId, projectId]);

  async function createSnapshot(e: React.FormEvent) {
    e.preventDefault();
    setSnapBusy(true);
    try {
      await apiPost(`/api/projects/${projectId}/prisma/snapshots`, { label: snapLabel.trim() });
      toast.success("Snapshot saved");
      setSnapOpen(false);
      setSnapLabel("");
      loadSnapshots();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Failed to create snapshot");
    } finally {
      setSnapBusy(false);
    }
  }

  async function createExport() {
    setExporting(true);
    try {
      await apiPost(`/api/projects/${projectId}/exports`, {
        kind: exportKind,
        format: exportKind === "FULL" ? "JSON" : exportFormat,
      });
      toast.success("Export ready — download it below");
      loadExports();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Failed to create export");
    } finally {
      setExporting(false);
    }
  }

  // Group live counts by PRISMA 2020 stage; keep any unrecognized keys visible.
  const byKey = new Map((report?.counts ?? []).map((c) => [c.key, c]));
  const groups = STAGE_GROUPS.map((g) => ({
    title: g.title,
    rows: g.keys.flatMap((k) => {
      const row = byKey.get(k);
      return row ? [row] : [];
    }),
  })).filter((g) => g.rows.length > 0);
  const knownKeys = new Set(KEY_ORDER);
  const otherRows = (report?.counts ?? []).filter((c) => !knownKeys.has(c.key));
  if (otherRows.length > 0) groups.push({ title: "Other", rows: otherRows });

  const excludedRow = report?.counts.find((c) => c.key === "reports_excluded");
  const reasonRows = excludedRow?.breakdown ? sortedBreakdown(excludedRow.breakdown) : [];

  const detailCounts = detail
    ? [...detail.counts].sort((a, b) => keyIndex(a.key) - keyIndex(b.key))
    : null;

  return (
    <div className="space-y-8">
      <PageHeader
        title="PRISMA flow"
        description="PRISMA 2020 counts computed live from current project data."
        actions={
          <>
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                setReport(null);
                loadReport();
              }}
            >
              <RefreshCw /> Refresh
            </Button>
            <Dialog open={snapOpen} onOpenChange={setSnapOpen}>
              <DialogTrigger asChild>
                <Button size="sm">
                  <Camera /> Take snapshot
                </Button>
              </DialogTrigger>
              <DialogContent>
                <DialogHeader>
                  <DialogTitle>Take a PRISMA snapshot</DialogTitle>
                  <DialogDescription>
                    Freezes the current counts so you can cite them later, e.g. in a manuscript.
                  </DialogDescription>
                </DialogHeader>
                <form onSubmit={createSnapshot} className="space-y-4">
                  <div className="space-y-1.5">
                    <Label htmlFor="snap-label">Label</Label>
                    <Input
                      id="snap-label"
                      required
                      maxLength={200}
                      placeholder="e.g. Manuscript submission"
                      value={snapLabel}
                      onChange={(e) => setSnapLabel(e.target.value)}
                    />
                  </div>
                  <DialogFooter>
                    <Button type="submit" disabled={snapBusy || snapLabel.trim().length === 0}>
                      {snapBusy && <Spinner />} Save snapshot
                    </Button>
                  </DialogFooter>
                </form>
              </DialogContent>
            </Dialog>
          </>
        }
      />

      {/* Live flow counts */}
      <section className="space-y-1">
        {report === null ? (
          <div className="space-y-4">
            <Skeleton className="h-28" />
            <Skeleton className="h-28" />
            <Skeleton className="h-28" />
          </div>
        ) : (
          <>
            <div className="space-y-1">
              {groups.map((group, i) => (
                <div key={group.title}>
                  {i > 0 && (
                    <div className="flex justify-center py-1.5">
                      <ArrowDown className="h-4 w-4 text-muted-foreground/50" />
                    </div>
                  )}
                  <h2 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                    {group.title}
                  </h2>
                  <div className="mt-2 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
                    {group.rows.map((row) => (
                      <CountBox key={row.key} row={row} />
                    ))}
                  </div>
                </div>
              ))}
            </div>
            <p className="pt-2 text-xs text-muted-foreground">
              Computed {new Date(report.computedAt).toLocaleString()}
            </p>
          </>
        )}
      </section>

      {/* Full-text exclusion reasons */}
      <section className="space-y-3">
        <h2 className="text-lg font-medium">Full-text exclusion reasons</h2>
        {report === null ? (
          <Skeleton className="h-32" />
        ) : reasonRows.length === 0 ? (
          <EmptyState
            icon={FileX}
            title="No full-text exclusions yet"
            description="Once full-text screening excludes reports, the reasons break down here."
          />
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Reason</TableHead>
                <TableHead className="text-right">Reports</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {reasonRows.map(([reason, count]) => (
                <TableRow key={reason}>
                  <TableCell className="font-medium">{reason}</TableCell>
                  <TableCell className="text-right tabular-nums">
                    {count.toLocaleString()}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </section>

      {/* Snapshots */}
      <section className="space-y-3">
        <h2 className="text-lg font-medium">Snapshots</h2>
        {snapshots === null ? (
          <Skeleton className="h-32" />
        ) : snapshots.length === 0 ? (
          <EmptyState
            icon={Camera}
            title="No snapshots yet"
            description="Take a snapshot to freeze the current PRISMA counts for reporting."
          />
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Label</TableHead>
                <TableHead>Created by</TableHead>
                <TableHead>Created</TableHead>
                <TableHead className="w-24" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {snapshots.map((s) => (
                <TableRow key={s.id}>
                  <TableCell className="font-medium">{s.label}</TableCell>
                  <TableCell className="text-muted-foreground">{s.createdBy.name}</TableCell>
                  <TableCell className="text-muted-foreground">
                    {new Date(s.createdAt).toLocaleString()}
                  </TableCell>
                  <TableCell>
                    <Button variant="ghost" size="sm" onClick={() => setDetailId(s.id)}>
                      <Eye /> View
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </section>

      {/* Snapshot detail dialog */}
      <Dialog open={detailId !== null} onOpenChange={(open) => !open && setDetailId(null)}>
        <DialogContent className="max-h-[80vh] max-w-xl overflow-y-auto">
          {detail === null || detailCounts === null ? (
            <>
              <DialogHeader>
                <DialogTitle>Snapshot</DialogTitle>
                <DialogDescription>Loading frozen counts…</DialogDescription>
              </DialogHeader>
              <Skeleton className="h-48" />
            </>
          ) : (
            <>
              <DialogHeader>
                <DialogTitle>{detail.label}</DialogTitle>
                <DialogDescription>
                  Frozen {new Date(detail.createdAt).toLocaleString()} by {detail.createdBy.name}
                </DialogDescription>
              </DialogHeader>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Count</TableHead>
                    <TableHead className="text-right">Value</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {detailCounts.map((c) => (
                    <TableRow key={c.key}>
                      <TableCell>
                        <p className="font-medium">{c.label}</p>
                        {c.breakdown && Object.keys(c.breakdown).length > 0 && (
                          <div className="mt-1 space-y-0.5">
                            {sortedBreakdown(c.breakdown).map(([label, n]) => (
                              <p key={label} className="text-xs text-muted-foreground">
                                {label} — {n.toLocaleString()}
                              </p>
                            ))}
                          </div>
                        )}
                      </TableCell>
                      <TableCell className="text-right align-top tabular-nums">
                        {c.value.toLocaleString()}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </>
          )}
        </DialogContent>
      </Dialog>

      {/* Exports */}
      <section className="space-y-3">
        <h2 className="text-lg font-medium">Exports</h2>
        {exportsForbidden ? (
          <p className="text-sm text-muted-foreground">
            Your role can&apos;t create or view exports for this project.
          </p>
        ) : (
          <>
            <div className="flex flex-wrap items-end gap-2">
              <div className="space-y-1.5">
                <Label htmlFor="exp-kind">Kind</Label>
                <div className="w-56">
                  <Select
                    id="exp-kind"
                    value={exportKind}
                    onChange={(e) => {
                      const kind = e.target.value;
                      setExportKind(kind);
                      if (kind === "FULL") setExportFormat("JSON");
                    }}
                  >
                    {EXPORT_KINDS.map((k) => (
                      <option key={k.value} value={k.value}>
                        {k.label}
                      </option>
                    ))}
                  </Select>
                </div>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="exp-format">Format</Label>
                <div className="w-32">
                  <Select
                    id="exp-format"
                    value={exportKind === "FULL" ? "JSON" : exportFormat}
                    disabled={exportKind === "FULL"}
                    onChange={(e) => setExportFormat(e.target.value)}
                  >
                    <option value="CSV">CSV</option>
                    <option value="JSON">JSON</option>
                  </Select>
                </div>
              </div>
              <Button onClick={createExport} disabled={exporting}>
                {exporting ? <Spinner /> : <FileDown />} Create export
              </Button>
            </div>

            {exportJobs === null ? (
              <Skeleton className="h-32" />
            ) : exportJobs.length === 0 ? (
              <EmptyState
                icon={FileDown}
                title="No exports yet"
                description="Create an export above to download project data as CSV or JSON."
              />
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Kind</TableHead>
                    <TableHead>Format</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead>Requested by</TableHead>
                    <TableHead>Created</TableHead>
                    <TableHead className="w-32" />
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {exportJobs.map((job) => (
                    <TableRow key={job.id}>
                      <TableCell className="font-medium">
                        {EXPORT_KIND_LABELS[job.kind] ?? job.kind}
                      </TableCell>
                      <TableCell className="text-muted-foreground">{job.format}</TableCell>
                      <TableCell>
                        <Badge
                          variant={
                            job.status === "COMPLETED"
                              ? "include"
                              : job.status === "FAILED"
                                ? "exclude"
                                : "muted"
                          }
                        >
                          {job.status.toLowerCase()}
                        </Badge>
                      </TableCell>
                      <TableCell className="text-muted-foreground">
                        {job.requestedBy.name}
                      </TableCell>
                      <TableCell className="text-muted-foreground">
                        {new Date(job.createdAt).toLocaleString()}
                      </TableCell>
                      <TableCell>
                        {job.status === "COMPLETED" ? (
                          <a
                            href={`/api/projects/${projectId}/exports/${job.id}/download`}
                            className={cn(buttonVariants({ variant: "outline", size: "sm" }))}
                          >
                            <Download /> Download
                          </a>
                        ) : (
                          <span className="text-xs text-muted-foreground">—</span>
                        )}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </>
        )}
      </section>
    </div>
  );
}
