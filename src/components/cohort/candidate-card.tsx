"use client";

// One companion-report candidate: side-by-side citation compare (mirrors the dedup
// PairCompare presentation), evidence chips derived from the engine signals, and
// Link / Reject actions with a live action preview + confirm dialog for Link.

import { useState } from "react";
import { Link2, X } from "lucide-react";
import { toast } from "sonner";
import { apiPost, ApiError } from "@/lib/api";
import { cn } from "@/lib/utils";
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
import type { CohortCandidate, CohortCitation, CohortLinkResult } from "./types";
import {
  COHORT_METHOD_LABELS,
  cohortScorePercent,
  evidenceChips,
  linkActionPreview,
} from "./types";

function authorText(citation: CohortCitation): string | null {
  const authors = Array.isArray(citation.authors) ? citation.authors : [];
  if (authors.length === 0) return null;
  return authors
    .map((a) => (a.given ? `${a.family} ${a.given}` : (a.raw ?? a.family)))
    .join(", ");
}

function studiesText(citation: CohortCitation): string | null {
  if (citation.studies.length === 0) return null;
  return citation.studies.map((s) => s.label).join(", ");
}

const LINK_CASE_MESSAGES: Record<CohortLinkResult["case"], string> = {
  LINKED_INTO_EXISTING: "Report added to the existing study",
  CREATED_STUDY: "New study created with both reports",
  MERGED_STUDIES: "Studies merged — both reports now share one study",
  ALREADY_SAME_STUDY: "Reports already shared a study — decision recorded",
};

export function CandidateCard({
  projectId,
  candidate,
  canManage,
  onChanged,
}: {
  projectId: string;
  candidate: CohortCandidate;
  canManage: boolean;
  onChanged: () => void;
}) {
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [linking, setLinking] = useState(false);
  const [rejecting, setRejecting] = useState(false);

  const decided = candidate.status !== "SUGGESTED";
  const chips = evidenceChips(candidate.signals);
  const preview = linkActionPreview(candidate);

  const fields: {
    label: string;
    value: (c: CohortCitation) => string | null;
    mono?: boolean;
  }[] = [
    { label: "Title", value: (c) => c.title },
    { label: "Authors", value: authorText },
    { label: "Year", value: (c) => (c.year !== null ? String(c.year) : null) },
    { label: "Journal", value: (c) => c.journal },
    { label: "DOI", value: (c) => c.doi, mono: true },
    { label: "Study", value: studiesText },
  ];

  async function link() {
    setLinking(true);
    try {
      const result = await apiPost<CohortLinkResult>(
        `/api/projects/${projectId}/cohort/candidates/${candidate.id}/link`,
      );
      toast.success("Companion reports linked", {
        description: LINK_CASE_MESSAGES[result.case],
      });
      setConfirmOpen(false);
      onChanged();
    } catch (err) {
      // 422 carries the blocked-merge explanation (manual reconciliation needed).
      toast.error(err instanceof ApiError ? err.message : "Failed to link candidate", {
        duration: 10000,
      });
      setConfirmOpen(false);
    } finally {
      setLinking(false);
    }
  }

  async function reject() {
    setRejecting(true);
    try {
      await apiPost(`/api/projects/${projectId}/cohort/candidates/${candidate.id}/reject`);
      toast.success("Marked as not the same cohort");
      onChanged();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Failed to reject candidate");
    } finally {
      setRejecting(false);
    }
  }

  return (
    <div className="rounded-lg border border-border bg-card shadow-sm">
      <div className="flex flex-wrap items-center gap-1.5 border-b border-border px-4 py-3">
        <Badge variant="outline">{COHORT_METHOD_LABELS[candidate.method]}</Badge>
        <Badge variant={candidate.score >= 0.9 ? "include" : "maybe"}>
          {cohortScorePercent(candidate.score)} match
        </Badge>
        {chips.map((chip) => (
          <Badge key={chip} variant="secondary">
            {chip}
          </Badge>
        ))}
        {decided && (
          <span className="ml-auto text-xs text-muted-foreground">
            <Badge variant={candidate.status === "LINKED" ? "include" : "muted"}>
              {candidate.status.toLowerCase()}
            </Badge>
            {candidate.decidedBy ? ` by ${candidate.decidedBy.name}` : ""}
            {candidate.decidedAt
              ? ` on ${new Date(candidate.decidedAt).toLocaleDateString()}`
              : ""}
          </span>
        )}
      </div>

      <div className="overflow-x-auto">
        <div className="min-w-[36rem]">
          <div className="grid grid-cols-[6.5rem_1fr_1fr] border-b border-border bg-muted/50 text-xs font-medium text-muted-foreground">
            <div />
            <div className="px-3 py-2">Report A</div>
            <div className="px-3 py-2">Report B</div>
          </div>
          {fields.map((f) => {
            const a = f.value(candidate.citationA);
            const b = f.value(candidate.citationB);
            if (a === null && b === null) return null;
            return (
              <div
                key={f.label}
                className="grid grid-cols-[6.5rem_1fr_1fr] border-b border-border text-sm last:border-b-0"
              >
                <div className="px-3 py-2 text-xs font-medium text-muted-foreground">
                  {f.label}
                </div>
                <div className={cn("border-l border-border px-3 py-2", f.mono && "font-mono text-xs")}>
                  {a ?? <span className="text-muted-foreground">—</span>}
                </div>
                <div className={cn("border-l border-border px-3 py-2", f.mono && "font-mono text-xs")}>
                  {b ?? <span className="text-muted-foreground">—</span>}
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {!decided && (
        <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border px-4 py-3">
          <p className="text-xs text-muted-foreground">{preview}</p>
          {canManage && (
            <div className="flex items-center gap-2">
              <Button
                variant="outline"
                size="sm"
                disabled={rejecting || linking}
                onClick={reject}
              >
                {rejecting ? <Spinner /> : <X />} Not the same cohort
              </Button>
              <Button size="sm" disabled={linking || rejecting} onClick={() => setConfirmOpen(true)}>
                <Link2 /> Link
              </Button>
            </div>
          )}
        </div>
      )}

      <Dialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Link companion reports?</DialogTitle>
            <DialogDescription>{preview}.</DialogDescription>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">
            Both reports will count as one study in analyses. This decision is audited.
          </p>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirmOpen(false)} disabled={linking}>
              Cancel
            </Button>
            <Button onClick={link} disabled={linking}>
              {linking ? <Spinner /> : <Link2 />} Confirm link
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
