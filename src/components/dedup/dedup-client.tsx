"use client";

import { useCallback, useEffect, useState } from "react";
import { CheckCheck, Copy, GitMerge, RotateCcw, ScanSearch, X } from "lucide-react";
import { toast } from "sonner";
import { api, apiPost, ApiError } from "@/lib/api";
import { PageHeader, StatCard } from "@/components/layout/page-header";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Alert, EmptyState, Skeleton, Spinner } from "@/components/ui/misc";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { GroupCard } from "./group-card";
import type {
  CitationListResponse,
  DedupGroup,
  DuplicateCitationRow,
  MergeWarning,
  RunSummary,
  UndoResult,
} from "./types";
import { METHOD_LABELS, scorePercent } from "./types";

const MERGES_PAGE_LIMIT = 200;
const CANONICAL_TITLE_FETCH_CAP = 60;

export function DedupClient({ projectId }: { projectId: string }) {
  const [openGroups, setOpenGroups] = useState<DedupGroup[] | null>(null);
  const [resolvedGroups, setResolvedGroups] = useState<DedupGroup[] | null>(null);
  const [duplicates, setDuplicates] = useState<DuplicateCitationRow[] | null>(null);
  const [hasMoreDuplicates, setHasMoreDuplicates] = useState(false);
  const [canonicalTitles, setCanonicalTitles] = useState<Record<string, string>>({});
  const [running, setRunning] = useState(false);
  const [undoingId, setUndoingId] = useState<string | null>(null);
  const [mergeWarning, setMergeWarning] = useState<MergeWarning | null>(null);

  const load = useCallback(() => {
    api<DedupGroup[]>(`/api/projects/${projectId}/dedup/groups?status=OPEN`)
      .then(setOpenGroups)
      .catch(() => {
        setOpenGroups([]);
        toast.error("Failed to load duplicate groups");
      });
    api<DedupGroup[]>(`/api/projects/${projectId}/dedup/groups?status=RESOLVED`)
      .then(setResolvedGroups)
      .catch(() => setResolvedGroups([]));
    api<CitationListResponse>(
      `/api/projects/${projectId}/citations?status=DUPLICATE&limit=${MERGES_PAGE_LIMIT}`,
    )
      .then((res) => {
        setDuplicates(res.items);
        setHasMoreDuplicates(res.nextCursor !== null);
      })
      .catch(() => setDuplicates([]));
  }, [projectId]);

  useEffect(load, [load]);

  // Resolve canonical titles for the merges tab ("" marks a failed lookup so we don't retry).
  useEffect(() => {
    if (duplicates === null) return;
    const ids = [
      ...new Set(
        duplicates
          .map((d) => d.duplicateOfId)
          .filter((id): id is string => id !== null && !(id in canonicalTitles)),
      ),
    ].slice(0, CANONICAL_TITLE_FETCH_CAP);
    if (ids.length === 0) return;
    let cancelled = false;
    Promise.all(
      ids.map((id) =>
        api<{ id: string; title: string }>(`/api/projects/${projectId}/citations/${id}`)
          .then((c) => [id, c.title] as const)
          .catch(() => [id, ""] as const),
      ),
    ).then((entries) => {
      if (!cancelled) setCanonicalTitles((prev) => ({ ...prev, ...Object.fromEntries(entries) }));
    });
    return () => {
      cancelled = true;
    };
  }, [duplicates, projectId, canonicalTitles]);

  async function runDetection() {
    setRunning(true);
    try {
      const s = await apiPost<RunSummary>(`/api/projects/${projectId}/dedup/run`);
      toast.success(
        `Detection found ${s.pairsDetected.toLocaleString()} candidate pair${s.pairsDetected === 1 ? "" : "s"} in ${s.groupsOpen.toLocaleString()} open group${s.groupsOpen === 1 ? "" : "s"}`,
        {
          description: `${s.citationsScanned.toLocaleString()} citations scanned · ${s.candidatesCreated} new · ${s.candidatesRefreshed} refreshed · ${s.candidatesSkippedDecided} already decided`,
        },
      );
      load();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Failed to run detection");
    } finally {
      setRunning(false);
    }
  }

  async function undoMerge(row: DuplicateCitationRow) {
    setUndoingId(row.id);
    try {
      const result = await apiPost<UndoResult>(
        `/api/projects/${projectId}/dedup/merges/${row.id}/undo`,
      );
      const restored = result.restoredAssignmentIds.length + result.restoredConflictIds.length;
      toast.success("Merge undone — citation restored to active", {
        description:
          restored > 0
            ? `${result.restoredAssignmentIds.length} screening assignments and ${result.restoredConflictIds.length} conflicts restored.`
            : undefined,
      });
      load();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Failed to undo merge");
    } finally {
      setUndoingId(null);
    }
  }

  const suggestedPairCount =
    openGroups?.reduce(
      (sum, g) => sum + g.candidates.filter((c) => c.status === "SUGGESTED").length,
      0,
    ) ?? null;

  return (
    <div className="space-y-6">
      <PageHeader
        title="Deduplication"
        description="Detect and merge duplicate citations before screening."
        actions={
          <Button onClick={runDetection} disabled={running}>
            {running ? <Spinner /> : <ScanSearch />} Run detection
          </Button>
        }
      />

      <div className="grid gap-4 sm:grid-cols-3">
        {openGroups === null || duplicates === null ? (
          <>
            <Skeleton className="h-24" />
            <Skeleton className="h-24" />
            <Skeleton className="h-24" />
          </>
        ) : (
          <>
            <StatCard label="Open groups" value={openGroups.length} />
            <StatCard label="Suggested pairs" value={suggestedPairCount ?? 0} />
            <StatCard
              label="Merged citations"
              value={`${duplicates.length}${hasMoreDuplicates ? "+" : ""}`}
            />
          </>
        )}
      </div>

      {mergeWarning !== null && (
        <Alert variant="warning">
          <div className="flex items-start justify-between gap-3">
            <span>{mergeWarning.message}</span>
            <button
              type="button"
              aria-label="Dismiss warning"
              className="shrink-0 opacity-70 hover:opacity-100"
              onClick={() => setMergeWarning(null)}
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        </Alert>
      )}

      <Tabs defaultValue="open">
        <TabsList>
          <TabsTrigger value="open">Open groups</TabsTrigger>
          <TabsTrigger value="resolved">Resolved</TabsTrigger>
          <TabsTrigger value="merges">Merged citations</TabsTrigger>
        </TabsList>

        <TabsContent value="open">
          {openGroups === null ? (
            <div className="space-y-3">
              <Skeleton className="h-20" />
              <Skeleton className="h-20" />
            </div>
          ) : openGroups.length === 0 ? (
            <EmptyState
              icon={Copy}
              title="No duplicate candidates"
              description="Run detection to scan the project's citations for exact and fuzzy duplicates."
              action={
                <Button size="sm" onClick={runDetection} disabled={running}>
                  {running ? <Spinner /> : <ScanSearch />} Run detection
                </Button>
              }
            />
          ) : (
            <div className="space-y-3">
              {openGroups.map((group) => (
                <GroupCard
                  key={group.id}
                  projectId={projectId}
                  group={group}
                  onChanged={load}
                  onMergeWarning={setMergeWarning}
                />
              ))}
            </div>
          )}
        </TabsContent>

        <TabsContent value="resolved">
          {resolvedGroups === null ? (
            <Skeleton className="h-40" />
          ) : resolvedGroups.length === 0 ? (
            <EmptyState
              icon={CheckCheck}
              title="No resolved groups"
              description="Groups appear here once every suggested pair has been merged or rejected."
            />
          ) : (
            <div className="rounded-lg border border-border bg-card">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Pair</TableHead>
                    <TableHead className="w-28">Method</TableHead>
                    <TableHead className="w-20">Score</TableHead>
                    <TableHead className="w-24">Decision</TableHead>
                    <TableHead>Decided by</TableHead>
                    <TableHead className="w-28">Date</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {resolvedGroups.flatMap((group) =>
                    group.candidates.map((c) => (
                      <TableRow key={c.id}>
                        <TableCell className="max-w-96">
                          <p className="truncate font-medium" title={c.citationA.title}>
                            {c.citationA.title}
                          </p>
                          <p className="truncate text-muted-foreground" title={c.citationB.title}>
                            vs {c.citationB.title}
                          </p>
                        </TableCell>
                        <TableCell>
                          <Badge variant="outline">{METHOD_LABELS[c.method]}</Badge>
                        </TableCell>
                        <TableCell className="tabular-nums">{scorePercent(c.score)}</TableCell>
                        <TableCell>
                          <Badge variant={c.status === "MERGED" ? "include" : "muted"}>
                            {c.status.toLowerCase()}
                          </Badge>
                        </TableCell>
                        <TableCell className="text-muted-foreground">
                          {c.decidedBy?.name ?? "—"}
                        </TableCell>
                        <TableCell className="text-muted-foreground">
                          {c.decidedAt ? new Date(c.decidedAt).toLocaleDateString() : "—"}
                        </TableCell>
                      </TableRow>
                    )),
                  )}
                </TableBody>
              </Table>
            </div>
          )}
        </TabsContent>

        <TabsContent value="merges">
          {duplicates === null ? (
            <Skeleton className="h-40" />
          ) : duplicates.length === 0 ? (
            <EmptyState
              icon={GitMerge}
              title="No merged citations"
              description="When you merge a duplicate group, the non-canonical citations are listed here and can be restored."
            />
          ) : (
            <div className="rounded-lg border border-border bg-card">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Merged citation</TableHead>
                    <TableHead>Merged into</TableHead>
                    <TableHead>Sources</TableHead>
                    <TableHead className="w-28">Updated</TableHead>
                    <TableHead className="w-24 text-right">Undo</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {duplicates.map((row) => {
                    const canonicalTitle =
                      row.duplicateOfId !== null ? canonicalTitles[row.duplicateOfId] : undefined;
                    return (
                      <TableRow key={row.id}>
                        <TableCell className="max-w-96">
                          <p className="truncate font-medium" title={row.title}>
                            {row.title}
                          </p>
                          <p className="text-xs text-muted-foreground">
                            {[
                              row.year !== null ? String(row.year) : null,
                              row.doi !== null ? `DOI ${row.doi}` : null,
                              row.pmid !== null ? `PMID ${row.pmid}` : null,
                            ]
                              .filter(Boolean)
                              .join(" · ") || "—"}
                          </p>
                        </TableCell>
                        <TableCell className="max-w-72">
                          {row.duplicateOfId === null ? (
                            <span className="text-muted-foreground">—</span>
                          ) : canonicalTitle === undefined ? (
                            <Skeleton className="h-4 w-40" />
                          ) : canonicalTitle === "" ? (
                            <span className="font-mono text-xs text-muted-foreground">
                              {row.duplicateOfId}
                            </span>
                          ) : (
                            <span className="line-clamp-2" title={canonicalTitle}>
                              {canonicalTitle}
                            </span>
                          )}
                        </TableCell>
                        <TableCell>
                          <div className="flex flex-wrap gap-1">
                            {(row.sources ?? []).map((s) => (
                              <Badge key={s.id} variant="secondary">
                                {s.name}
                              </Badge>
                            ))}
                            {(row.sources ?? []).length === 0 && (
                              <span className="text-muted-foreground">—</span>
                            )}
                          </div>
                        </TableCell>
                        <TableCell className="text-muted-foreground">
                          {new Date(row.updatedAt).toLocaleDateString()}
                        </TableCell>
                        <TableCell className="text-right">
                          <Button
                            variant="outline"
                            size="sm"
                            disabled={undoingId === row.id}
                            onClick={() => undoMerge(row)}
                          >
                            {undoingId === row.id ? <Spinner /> : <RotateCcw />} Undo
                          </Button>
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
              {hasMoreDuplicates && (
                <p className="border-t border-border px-4 py-3 text-sm text-muted-foreground">
                  Showing the first {MERGES_PAGE_LIMIT} merged citations.
                </p>
              )}
            </div>
          )}
        </TabsContent>
      </Tabs>
    </div>
  );
}
