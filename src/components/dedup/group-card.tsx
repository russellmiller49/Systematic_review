"use client";

import { useMemo, useState } from "react";
import { ChevronDown, ChevronRight, GitMerge, X } from "lucide-react";
import { toast } from "sonner";
import { apiPost, ApiError } from "@/lib/api";
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
import { Spinner } from "@/components/ui/misc";
import { PairCompare } from "./pair-compare";
import { hasConferencePublicationPair } from "@/lib/dedup-publication";
import type {
  DedupCandidate,
  DedupGroup,
  MergeResult,
  MergeWarning,
  RejectResult,
} from "./types";
import { DECISION_LABELS, METHOD_LABELS, scorePercent } from "./types";

function scoreVariant(score: number): "include" | "maybe" {
  return score >= 0.95 ? "include" : "maybe";
}

// One candidate-duplicate group: summary row, expandable pair-by-pair comparison,
// canonical selection (radio, shared across pairs), merge + per-pair reject actions.
export function GroupCard({
  projectId,
  group,
  canManage,
  onChanged,
  onMergeWarning,
}: {
  projectId: string;
  group: DedupGroup;
  canManage: boolean;
  onChanged: () => Promise<void>;
  onMergeWarning: (warning: MergeWarning) => void;
}) {
  const [confirmCompanionsOpen, setConfirmCompanionsOpen] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [canonicalId, setCanonicalId] = useState<string | null>(null);
  const [merging, setMerging] = useState(false);
  const [rejectingId, setRejectingId] = useState<string | null>(null);

  const suggested = useMemo(
    () => group.candidates.filter((c) => c.status === "SUGGESTED"),
    [group],
  );
  const decided = useMemo(
    () => group.candidates.filter((c) => c.status !== "SUGGESTED"),
    [group],
  );
  const memberCount = useMemo(() => {
    const ids = new Set<string>();
    for (const c of suggested) {
      ids.add(c.citationAId);
      ids.add(c.citationBId);
    }
    return ids.size;
  }, [suggested]);
  const methods = useMemo(
    () => [...new Set(suggested.map((c) => c.method))],
    [suggested],
  );
  const topScore =
    suggested.length > 0 ? Math.max(...suggested.map((c) => c.score)) : 0;
  const leadTitle =
    suggested[0]?.citationA.title ?? group.candidates[0]?.citationA.title ?? "";

  const hasConflict = group.metadataConflicts.length > 0;
  const hasPublicationPair = hasConferencePublicationPair(
    suggested.flatMap((candidate) => [
      candidate.citationA,
      candidate.citationB,
    ]),
  );
  const canonicalIsMember = suggested.some(
    (c) => c.citationAId === canonicalId || c.citationBId === canonicalId,
  );

  async function merge() {
    if (canonicalId === null) return;
    setMerging(true);
    try {
      const result = await apiPost<MergeResult>(
        `/api/projects/${projectId}/dedup/groups/${group.id}/merge`,
        { canonicalCitationId: canonicalId },
      );
      toast.success(
        `Merged ${result.mergedCitationIds.length} citation${result.mergedCitationIds.length === 1 ? "" : "s"} into the canonical record`,
      );
      if (result.warning !== null) {
        toast.warning(result.warning.message, { duration: 12000 });
        onMergeWarning(result.warning);
      }
      await onChanged();
    } catch (err) {
      toast.error(
        err instanceof ApiError ? err.message : "Failed to merge group",
      );
      if (err instanceof ApiError && err.code === "INVALID_STATE")
        await onChanged();
    } finally {
      setMerging(false);
    }
  }

  async function reject(candidate: DedupCandidate) {
    setRejectingId(candidate.id);
    try {
      const result = await apiPost<RejectResult>(
        `/api/projects/${projectId}/dedup/candidates/${candidate.id}/reject`,
      );
      toast.success("Marked as not a duplicate", {
        description: result.groupResolved
          ? "No suggested pairs left — the group was resolved."
          : "Duplicate clusters have been refreshed; disconnected citations are shown separately.",
      });
      await onChanged();
    } catch (err) {
      toast.error(
        err instanceof ApiError ? err.message : "Failed to reject candidate",
      );
    } finally {
      setRejectingId(null);
    }
  }

  async function markCompanion(candidateId?: string) {
    setRejectingId(candidateId ?? "group");
    try {
      await apiPost(
        candidateId
          ? `/api/projects/${projectId}/dedup/candidates/${candidateId}/companion`
          : `/api/projects/${projectId}/dedup/groups/${group.id}/companion`,
        candidateId
          ? undefined
          : { confirmed: true, candidateIds: suggested.map((c) => c.id) },
      );
      toast.success("Same study / separate report recorded", {
        description:
          "Citations retained. Eligible reports will share one study after full-text inclusion.",
      });
      setConfirmCompanionsOpen(false);
      await onChanged();
    } catch (err) {
      toast.error(
        err instanceof ApiError
          ? err.message
          : "Failed to record companion reports",
      );
      if (err instanceof ApiError && err.code === "INVALID_STATE")
        await onChanged();
    } finally {
      setRejectingId(null);
    }
  }

  return (
    <div className="rounded-lg border border-border bg-card shadow-sm">
      <button
        type="button"
        className="flex w-full flex-wrap items-center gap-3 px-5 py-4 text-left"
        onClick={() => setExpanded((v) => !v)}
        aria-expanded={expanded}
      >
        {expanded ? (
          <ChevronDown className="h-4 w-4 shrink-0 text-muted-foreground" />
        ) : (
          <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" />
        )}
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium" title={leadTitle}>
            {leadTitle}
          </p>
          <p className="mt-0.5 text-xs text-muted-foreground">
            {memberCount} citations · {suggested.length} suggested pair
            {suggested.length === 1 ? "" : "s"}
            {decided.length > 0 ? ` · ${decided.length} already decided` : ""}
          </p>
        </div>
        <div className="flex w-full flex-wrap items-center gap-1.5 sm:w-auto sm:max-w-[50%]">
          {methods.map((m) => (
            <Badge key={m} variant="outline">
              {METHOD_LABELS[m]}
            </Badge>
          ))}
          {hasConflict ? (
            <Badge variant="maybe">
              Identifier / metadata conflict — manual review required
            </Badge>
          ) : hasPublicationPair ? (
            <Badge variant="maybe">
              Possible conference / full publication — review reports
            </Badge>
          ) : (
            suggested.length > 0 && (
              <Badge variant={scoreVariant(topScore)}>
                {scorePercent(topScore)} match
              </Badge>
            )
          )}
          {hasPublicationPair && hasConflict && (
            <Badge variant="maybe">
              Possible conference / full publication — review reports
            </Badge>
          )}
        </div>
      </button>

      {expanded && (
        <div className="space-y-4 border-t border-border px-5 py-4">
          <p className="text-sm text-muted-foreground">
            Choose the citation to retain for this duplicate cluster. All other
            citations still connected by remaining duplicate suggestions in this
            cluster will be marked as duplicates. Suggestions are possible
            matches, not confirmed duplicates. Reject false relationships before
            merging; this may split the cluster into separate cards. Choose
            “Same study / separate report” for different publications of one
            underlying cohort.
          </p>

          {hasConflict && (
            <div role="note" className="rounded-md bg-maybe-muted p-3 text-sm">
              <p className="font-medium">
                Identifier / metadata conflict — manual review required
              </p>
              <ul className="list-inside list-disc">
                {group.metadataConflicts.map((reason) => (
                  <li key={reason}>{reason}</li>
                ))}
              </ul>
              <p>
                Check the imported records before merging. Matching identifiers
                may contain errors.
              </p>
            </div>
          )}

          {suggested.map((candidate) => (
            <div key={candidate.id} className="space-y-2">
              <PairCompare
                a={candidate.citationA}
                b={candidate.citationB}
                reasons={candidate.reasons}
                metadataConflicts={candidate.metadataConflicts}
                radioName={`canonical-${group.id}`}
                canonicalId={canonicalId}
                onSelectCanonical={canManage ? setCanonicalId : undefined}
              />
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                  <Badge variant="outline">
                    {METHOD_LABELS[candidate.method]}
                  </Badge>
                  <Badge
                    variant={
                      candidate.metadataConflicts.length ||
                      hasConferencePublicationPair([
                        candidate.citationA,
                        candidate.citationB,
                      ])
                        ? "maybe"
                        : scoreVariant(candidate.score)
                    }
                  >
                    {candidate.metadataConflicts.length ||
                    hasConferencePublicationPair([
                      candidate.citationA,
                      candidate.citationB,
                    ])
                      ? "Manual review required"
                      : scorePercent(candidate.score)}
                  </Badge>
                  {candidate.reasons !== null && (
                    <span>
                      Title{" "}
                      {Math.round(candidate.reasons.titleSimilarity * 100)}% ·
                      Authors{" "}
                      {Math.round(candidate.reasons.authorOverlap * 100)}%
                    </span>
                  )}
                </div>
                <div className="flex flex-wrap gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    title="Keep both citations. These appear to be different reports of the same underlying study or cohort."
                    disabled={!canManage || rejectingId !== null || merging}
                    onClick={() => markCompanion(candidate.id)}
                  >
                    Same study / separate report
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={!canManage || rejectingId !== null || merging}
                    onClick={() => reject(candidate)}
                  >
                    {rejectingId === candidate.id ? <Spinner /> : <X />} Not a
                    duplicate
                  </Button>
                </div>
              </div>
            </div>
          ))}

          {decided.length > 0 && (
            <div className="rounded-md border border-border bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
              {decided.map((c) => (
                <div key={c.id} className="truncate">
                  <Badge variant="muted" className="mr-1.5">
                    {DECISION_LABELS[c.status]}
                  </Badge>
                  {c.citationA.title}
                  {c.decidedBy ? ` — decided by ${c.decidedBy.name}` : ""}
                  {c.decidedAt
                    ? ` on ${new Date(c.decidedAt).toLocaleDateString()}`
                    : ""}
                </div>
              ))}
            </div>
          )}

          {suggested.length > 0 && (
            <div className="flex flex-wrap justify-end gap-2 border-t border-border pt-4">
              <Button
                variant="outline"
                disabled={!canManage || merging || rejectingId !== null}
                onClick={() => setConfirmCompanionsOpen(true)}
              >
                Mark all as separate reports of the same study
              </Button>
              <Button
                onClick={merge}
                disabled={
                  !canManage ||
                  merging ||
                  rejectingId !== null ||
                  !canonicalIsMember
                }
              >
                {merging ? <Spinner /> : <GitMerge />}
                {canonicalId === null
                  ? "Select a canonical citation to merge"
                  : "Merge group"}
              </Button>
            </div>
          )}
        </div>
      )}
      <Dialog
        open={confirmCompanionsOpen}
        onOpenChange={setConfirmCompanionsOpen}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Separate reports of one study?</DialogTitle>
            <DialogDescription>
              All {memberCount} citations will stay active; no citations will be
              merged. Every current suggested pair ({suggested.length}) in this
              cluster will be recorded as a confirmed same-study / companion
              relationship, resolving the duplicate cluster.
            </DialogDescription>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">
            Confirm only if every citation is a separate report of the same
            underlying study. If some are duplicate copies of one publication,
            classify those pairs separately first. Reports that pass full-text
            screening will share one study to prevent counting the cohort twice.
            Excluded reports will remain unlinked. Existing study work may
            require manual reconciliation.
          </p>
          <DialogFooter>
            <Button
              variant="outline"
              disabled={rejectingId !== null}
              onClick={() => setConfirmCompanionsOpen(false)}
            >
              Cancel
            </Button>
            <Button
              disabled={rejectingId !== null}
              onClick={() => markCompanion()}
            >
              Confirm separate reports
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
