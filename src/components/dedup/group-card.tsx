"use client";

import { useMemo, useState } from "react";
import { ChevronDown, ChevronRight, GitMerge, X } from "lucide-react";
import { toast } from "sonner";
import { apiPost, ApiError } from "@/lib/api";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/misc";
import { PairCompare } from "./pair-compare";
import type { DedupCandidate, DedupGroup, MergeResult, MergeWarning, RejectResult } from "./types";
import { METHOD_LABELS, scorePercent } from "./types";

function scoreVariant(score: number): "include" | "maybe" {
  return score >= 0.95 ? "include" : "maybe";
}

// One candidate-duplicate group: summary row, expandable pair-by-pair comparison,
// canonical selection (radio, shared across pairs), merge + per-pair reject actions.
export function GroupCard({
  projectId,
  group,
  onChanged,
  onMergeWarning,
}: {
  projectId: string;
  group: DedupGroup;
  onChanged: () => void;
  onMergeWarning: (warning: MergeWarning) => void;
}) {
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
  const methods = useMemo(() => [...new Set(suggested.map((c) => c.method))], [suggested]);
  const topScore = suggested.length > 0 ? Math.max(...suggested.map((c) => c.score)) : 0;
  const leadTitle = suggested[0]?.citationA.title ?? group.candidates[0]?.citationA.title ?? "";

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
      onChanged();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Failed to merge group");
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
          : undefined,
      });
      onChanged();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Failed to reject candidate");
    } finally {
      setRejectingId(null);
    }
  }

  return (
    <div className="rounded-lg border border-border bg-card shadow-sm">
      <button
        type="button"
        className="flex w-full items-center gap-3 px-5 py-4 text-left"
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
        <div className="flex shrink-0 items-center gap-1.5">
          {methods.map((m) => (
            <Badge key={m} variant="outline">
              {METHOD_LABELS[m]}
            </Badge>
          ))}
          {suggested.length > 0 && (
            <Badge variant={scoreVariant(topScore)}>{scorePercent(topScore)} match</Badge>
          )}
        </div>
      </button>

      {expanded && (
        <div className="space-y-4 border-t border-border px-5 py-4">
          <p className="text-sm text-muted-foreground">
            Pick the record to keep, then merge — the other citations become duplicates of it.
            Reject a pair if it is not a true duplicate.
          </p>

          {suggested.map((candidate) => (
            <div key={candidate.id} className="space-y-2">
              <PairCompare
                a={candidate.citationA}
                b={candidate.citationB}
                reasons={candidate.reasons}
                radioName={`canonical-${group.id}`}
                canonicalId={canonicalId}
                onSelectCanonical={setCanonicalId}
              />
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                  <Badge variant="outline">{METHOD_LABELS[candidate.method]}</Badge>
                  <Badge variant={scoreVariant(candidate.score)}>
                    {scorePercent(candidate.score)}
                  </Badge>
                  {candidate.reasons !== null && (
                    <span>
                      Title {Math.round(candidate.reasons.titleSimilarity * 100)}% · Authors{" "}
                      {Math.round(candidate.reasons.authorOverlap * 100)}%
                    </span>
                  )}
                </div>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={rejectingId === candidate.id}
                  onClick={() => reject(candidate)}
                >
                  {rejectingId === candidate.id ? <Spinner /> : <X />} Not a duplicate
                </Button>
              </div>
            </div>
          ))}

          {decided.length > 0 && (
            <div className="rounded-md border border-border bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
              {decided.map((c) => (
                <p key={c.id} className="truncate">
                  <Badge variant="muted" className="mr-1.5">
                    {c.status.toLowerCase()}
                  </Badge>
                  {c.citationA.title}
                  {c.decidedBy ? ` — decided by ${c.decidedBy.name}` : ""}
                  {c.decidedAt ? ` on ${new Date(c.decidedAt).toLocaleDateString()}` : ""}
                </p>
              ))}
            </div>
          )}

          {suggested.length > 0 && (
            <div className="flex justify-end border-t border-border pt-4">
              <Button onClick={merge} disabled={merging || canonicalId === null}>
                {merging ? <Spinner /> : <GitMerge />}
                {canonicalId === null ? "Select a canonical citation to merge" : "Merge group"}
              </Button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
