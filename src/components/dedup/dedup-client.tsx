"use client";

import { useCallback, useEffect, useState } from "react";
import { CheckCheck, Copy, GitMerge, RotateCcw, ScanSearch, X } from "lucide-react";
import { toast } from "sonner";
import { api, apiPost, ApiError } from "@/lib/api";
import { PageHeader, StatCard } from "@/components/layout/page-header";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
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
  BulkExactDoiResult,
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
  const [bulkMergeOpen, setBulkMergeOpen] = useState(false);
  const [bulkMerging, setBulkMerging] = useState(false);
  const [bulkNotice, setBulkNotice] = useState<string | null>(null);
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

  async function bulkMergeExactDoi() {
    setBulkMerging(true);
    setBulkNotice(null);
    try {
      const result = await apiPost<BulkExactDoiResult>(
        `/api/projects/${projectId}/dedup/merge-exact-doi`,
      );
      setBulkMergeOpen(false);
      if (result.groupsMerged === 0) {
        toast.info("No exact DOI groups were ready to merge");
      } else {
        toast.success(
          `Merged ${result.citationsMerged} duplicate citation${result.citationsMerged === 1 ? "" : "s"} across ${result.groupsMerged} exact DOI group${result.groupsMerged === 1 ? "" : "s"}`,
        );
      }
      const notices: string[] = [];
      if (result.screeningHistoryWarningCount > 0) {
        notices.push(
          `${result.screeningHistoryWarningCount} merged group${result.screeningHistoryWarningCount === 1 ? " had" : "s had"} screening decisions on multiple records. The automatically selected canonical record is authoritative; all prior decisions remain preserved in the audit trail.`,
        );
      }
      if (result.groupsSkippedForReview > 0) {
        notices.push(
          `${result.groupsSkippedForReview} group${result.groupsSkippedForReview === 1 ? " was" : "s were"} left open because it also contained non-DOI evidence or stale citation data.`,
        );
      }
      setBulkNotice(notices.length > 0 ? notices.join(" ") : null);
      load();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Failed to merge exact DOI matches");
    } finally {
      setBulkMerging(false);
    }
  }

  const suggestedPairCount =
    openGroups?.reduce(
      (sum, g) => sum + g.candidates.filter((c) => c.status === "SUGGESTED").length,
      0,
    ) ?? null;
  const exactDoiGroups =
    openGroups?.filter((group) => {
      const suggested = group.candidates.filter((candidate) => candidate.status === "SUGGESTED");
      return (
        suggested.length > 0 &&
        !group.candidates.some((candidate) => candidate.status === "REJECTED") &&
        suggested.every(
          (candidate) => candidate.method === "EXACT_DOI" && candidate.score === 1,
        )
      );
    }) ?? [];
  const exactDoiCitationCount = exactDoiGroups.reduce((count, group) => {
    const citationIds = new Set<string>();
    for (const candidate of group.candidates) {
      if (candidate.status !== "SUGGESTED") continue;
      citationIds.add(candidate.citationAId);
      citationIds.add(candidate.citationBId);
    }
    return count + Math.max(0, citationIds.size - 1);
  }, 0);
  const mixedExactDoiGroupCount =
    openGroups?.filter((group) => {
      const suggested = group.candidates.filter((candidate) => candidate.status === "SUGGESTED");
      return (
        suggested.some(
          (candidate) => candidate.method === "EXACT_DOI" && candidate.score === 1,
        ) &&
        suggested.some(
          (candidate) => candidate.method !== "EXACT_DOI" || candidate.score !== 1,
        )
      );
    }).length ?? 0;

  return (
    <div className="space-y-6">
      <PageHeader
        title="Deduplication"
        description="Detect and merge duplicate citations before screening."
        actions={
          <div className="flex flex-wrap gap-2">
            <Button
              variant="outline"
              onClick={() => setBulkMergeOpen(true)}
              disabled={bulkMerging || exactDoiGroups.length === 0}
            >
              {bulkMerging ? <Spinner /> : <GitMerge />} Merge exact DOI matches
              {exactDoiGroups.length > 0 && ` (${exactDoiGroups.length})`}
            </Button>
            <Button onClick={runDetection} disabled={running || bulkMerging}>
              {running ? <Spinner /> : <ScanSearch />} Run detection
            </Button>
          </div>
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

      {bulkNotice !== null && (
        <Alert variant="warning">
          <div className="flex items-start justify-between gap-3">
            <span>{bulkNotice}</span>
            <button
              type="button"
              aria-label="Dismiss bulk merge notice"
              className="shrink-0 opacity-70 hover:opacity-100"
              onClick={() => setBulkNotice(null)}
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

      <Dialog open={bulkMergeOpen} onOpenChange={setBulkMergeOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              Merge {exactDoiCitationCount} exact DOI duplicate
              {exactDoiCitationCount === 1 ? "" : "s"}?
            </DialogTitle>
            <DialogDescription>
              This will resolve {exactDoiGroups.length} group
              {exactDoiGroups.length === 1 ? "" : "s"} whose suggested pairs all share the
              same DOI. Each merge can still be undone from the Merged citations tab.
            </DialogDescription>
          </DialogHeader>
          <Alert variant="warning">
            Synthesis automatically keeps the record with existing screening decisions. Otherwise
            it keeps the most complete citation, using the oldest-created record to break a tie.
            Pending assignments and open conflicts on merged records will be voided under the
            existing deduplication rules.
          </Alert>
          {mixedExactDoiGroupCount > 0 && (
            <Alert variant="info">
              {mixedExactDoiGroupCount} additional group
              {mixedExactDoiGroupCount === 1 ? " contains" : "s contain"} an exact DOI pair plus
              other match types. {mixedExactDoiGroupCount === 1 ? "It" : "They"} will remain open
              for manual review.
            </Alert>
          )}
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setBulkMergeOpen(false)}
              disabled={bulkMerging}
            >
              Cancel
            </Button>
            <Button onClick={bulkMergeExactDoi} disabled={bulkMerging}>
              {bulkMerging ? <Spinner /> : <GitMerge />} Merge exact DOI matches
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
