"use client";

import { useCallback, useEffect, useState } from "react";
import { ListRestart } from "lucide-react";
import { toast } from "sonner";
import { api, apiDelete, ApiError } from "@/lib/api";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Alert, EmptyState, Skeleton, Spinner } from "@/components/ui/misc";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Textarea } from "@/components/ui/textarea";
import { roleLabel } from "@/components/settings/roles";
import {
  STAGE_LABELS,
  type AssignmentAdminReviewer,
  type AssignmentAdminSummary,
  type ScreeningStageSummary,
} from "./types";

interface ResetTarget {
  reviewerIds?: string[];
  label: string;
  pending: number;
}

interface ResetResult {
  deleted: number;
  protectedAssignments: number;
  remainingAssignments: number;
  affectedReviewerIds: string[];
}

export function ManageAssignmentsDialog({
  projectId,
  stage,
  onAssignmentsChanged,
}: {
  projectId: string;
  stage: ScreeningStageSummary;
  onAssignmentsChanged: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [summary, setSummary] = useState<AssignmentAdminSummary | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [target, setTarget] = useState<ResetTarget | null>(null);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const endpoint = `/api/projects/${projectId}/screening/stages/${stage.id}/assignments`;

  const load = useCallback(async () => {
    setLoadError(null);
    try {
      setSummary(await api<AssignmentAdminSummary>(endpoint));
    } catch (err) {
      setLoadError(err instanceof ApiError ? err.message : "Failed to load assignments");
      setSummary(null);
    }
  }, [endpoint]);

  useEffect(() => {
    if (open) void load();
  }, [load, open]);

  function chooseTarget(reviewer?: AssignmentAdminReviewer) {
    setReason("");
    setTarget(
      reviewer
        ? {
            reviewerIds: [reviewer.reviewer.id],
            label: reviewer.reviewer.name,
            pending: reviewer.pending,
          }
        : {
            label: "all reviewers",
            pending: summary?.totals.pending ?? 0,
          },
    );
  }

  async function resetAssignments(e: React.FormEvent) {
    e.preventDefault();
    if (!target || reason.trim().length < 3) return;
    setBusy(true);
    try {
      const result = await apiDelete<ResetResult>(endpoint, {
        reviewerIds: target.reviewerIds,
        reason: reason.trim(),
      });
      toast.success(
        `${result.deleted.toLocaleString()} pending assignment${result.deleted === 1 ? "" : "s"} removed`,
        {
          description:
            result.protectedAssignments > 0
              ? `${result.protectedAssignments.toLocaleString()} completed or otherwise protected assignment${result.protectedAssignments === 1 ? " was" : "s were"} left unchanged.`
              : "No completed work or decisions were changed.",
        },
      );
      setTarget(null);
      setReason("");
      await load();
      onAssignmentsChanged();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Failed to reset assignments");
    } finally {
      setBusy(false);
    }
  }

  function handleOpenChange(next: boolean) {
    setOpen(next);
    if (!next) {
      setTarget(null);
      setReason("");
      setSummary(null);
      setLoadError(null);
    }
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogTrigger asChild>
        <Button variant="outline" size="sm">
          <ListRestart /> Manage assignments
        </Button>
      </DialogTrigger>
      <DialogContent className="max-h-[85vh] max-w-4xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>
            Manage {STAGE_LABELS[stage.type].toLowerCase()} assignments
          </DialogTitle>
          <DialogDescription>
            Review each person&apos;s workload or remove work that has not been started.
          </DialogDescription>
        </DialogHeader>

        <Alert variant="info">
          Only pending assignments without a saved decision can be removed. Completed assignments,
          decisions, conflicts, and results are always preserved.
        </Alert>

        {loadError ? (
          <Alert variant="error">{loadError}</Alert>
        ) : summary === null ? (
          <div className="space-y-3">
            <Skeleton className="h-16" />
            <Skeleton className="h-40" />
          </div>
        ) : (
          <>
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
              {[
                ["Assignments", summary.totals.assignments],
                ["Pending", summary.totals.pending],
                ["Completed", summary.totals.completed],
                ["Decisions", summary.totals.decisions],
              ].map(([label, value]) => (
                <div key={label} className="rounded-md border border-border bg-muted/30 px-3 py-2">
                  <p className="text-xs text-muted-foreground">{label}</p>
                  <p className="text-lg font-semibold">{Number(value).toLocaleString()}</p>
                </div>
              ))}
            </div>

            {summary.reviewers.length === 0 ? (
              <EmptyState
                icon={ListRestart}
                title="No assignments"
                description="Use Assign reviewers when you are ready to send citations to screening."
              />
            ) : (
              <div className="rounded-lg border border-border">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Reviewer</TableHead>
                      <TableHead>Roles</TableHead>
                      <TableHead className="text-right">Pending</TableHead>
                      <TableHead className="text-right">Completed</TableHead>
                      <TableHead className="text-right">Decisions</TableHead>
                      <TableHead className="w-32" />
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {summary.reviewers.map((reviewer) => (
                      <TableRow key={reviewer.reviewer.id}>
                        <TableCell>
                          <p className="font-medium">{reviewer.reviewer.name}</p>
                          <p className="text-xs text-muted-foreground">
                            {reviewer.reviewer.email || "No longer a project member"}
                          </p>
                        </TableCell>
                        <TableCell>
                          <div className="flex max-w-48 flex-wrap gap-1">
                            {reviewer.roles.map((role) => (
                              <Badge key={role} variant="secondary">
                                {roleLabel(role)}
                              </Badge>
                            ))}
                            {reviewer.memberStatus !== "ACTIVE" && (
                              <Badge variant="muted">{reviewer.memberStatus.toLowerCase()}</Badge>
                            )}
                          </div>
                        </TableCell>
                        <TableCell className="text-right">{reviewer.pending.toLocaleString()}</TableCell>
                        <TableCell className="text-right">{reviewer.completed.toLocaleString()}</TableCell>
                        <TableCell className="text-right">{reviewer.decisions.toLocaleString()}</TableCell>
                        <TableCell className="text-right">
                          <Button
                            variant="ghost"
                            size="sm"
                            disabled={reviewer.pending === 0}
                            onClick={() => chooseTarget(reviewer)}
                          >
                            Remove pending
                          </Button>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            )}

            {target && (
              <form onSubmit={resetAssignments} className="space-y-3 rounded-lg border border-destructive/30 bg-destructive/5 p-4">
                <div>
                  <p className="font-medium">Remove pending assignments for {target.label}?</p>
                  <p className="text-sm text-muted-foreground">
                    Up to {target.pending.toLocaleString()} pending assignment{target.pending === 1 ? "" : "s"} will be removed. Protected work will remain.
                  </p>
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="assignment-reset-reason">Reason for audit trail</Label>
                  <Textarea
                    id="assignment-reset-reason"
                    required
                    minLength={3}
                    maxLength={2000}
                    value={reason}
                    onChange={(event) => setReason(event.target.value)}
                    placeholder="For example: Imported the wrong search set before screening began"
                  />
                </div>
                <DialogFooter>
                  <Button variant="outline" onClick={() => setTarget(null)} disabled={busy}>
                    Cancel
                  </Button>
                  <Button type="submit" variant="destructive" disabled={busy || reason.trim().length < 3}>
                    {busy && <Spinner />} Remove pending assignments
                  </Button>
                </DialogFooter>
              </form>
            )}
          </>
        )}

        {summary && !target && summary.totals.pending > 0 && (
          <DialogFooter>
            <Button variant="destructive" onClick={() => chooseTarget()}>
              Remove all pending assignments
            </Button>
          </DialogFooter>
        )}
      </DialogContent>
    </Dialog>
  );
}
