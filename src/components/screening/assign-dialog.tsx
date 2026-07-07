"use client";

import { useEffect, useMemo, useState } from "react";
import { Users } from "lucide-react";
import { toast } from "sonner";
import { api, apiPost, ApiError } from "@/lib/api";
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
import { Select } from "@/components/ui/select";
import { Spinner } from "@/components/ui/misc";
import { STAGE_LABELS, type ScreeningStageSummary } from "./types";

// Roles that hold `screening.decide` (permission matrix). Only these can be assigned to screen.
const SCREENING_ROLES = new Set(["OWNER", "ADMIN", "REVIEWER", "ADJUDICATOR", "TRAINEE"]);

interface MemberRow {
  id: string;
  roles: string[];
  status: string;
  user: { id: string; name: string; email: string };
}

function toggle(set: Set<string>, id: string): Set<string> {
  const next = new Set(set);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  return next;
}

/**
 * Bulk screening assignment for one stage (screening.configure — OWNER/ADMIN).
 * Assigns the whole eligible citation pool to the chosen reviewers; the server intersects
 * FULL_TEXT with title/abstract INCLUDE results and skips existing pairs.
 */
export function AssignReviewersDialog({
  projectId,
  stage,
  onAssigned,
}: {
  projectId: string;
  stage: ScreeningStageSummary;
  onAssigned: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [members, setMembers] = useState<MemberRow[] | null>(null);
  const [reviewerIds, setReviewerIds] = useState<Set<string>>(new Set());
  const [strategy, setStrategy] = useState<"all" | "split">("all");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    api<MemberRow[]>(`/api/projects/${projectId}/members`)
      .then(setMembers)
      .catch(() => setMembers([]));
  }, [open, projectId]);

  const eligible = useMemo(
    () =>
      (members ?? []).filter(
        (m) => m.status === "ACTIVE" && m.roles.some((r) => SCREENING_ROLES.has(r)),
      ),
    [members],
  );

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (reviewerIds.size === 0) {
      toast.error("Select at least one reviewer");
      return;
    }
    if (strategy === "split" && reviewerIds.size < stage.reviewersPerCitation) {
      toast.error(`Split assignment needs at least ${stage.reviewersPerCitation} reviewers`);
      return;
    }
    setBusy(true);
    try {
      const result = await apiPost<{
        created: number;
        skippedExisting: number;
        eligibleCitations: number;
      }>(`/api/projects/${projectId}/screening/stages/${stage.id}/assignments`, {
        reviewerIds: [...reviewerIds],
        strategy,
      });
      toast.success(
        `${result.created.toLocaleString()} assignment${result.created === 1 ? "" : "s"} created ` +
          `across ${result.eligibleCitations.toLocaleString()} citation${result.eligibleCitations === 1 ? "" : "s"}`,
        {
          description:
            result.skippedExisting > 0
              ? `${result.skippedExisting.toLocaleString()} existing pairs skipped.`
              : undefined,
        },
      );
      setOpen(false);
      setReviewerIds(new Set());
      onAssigned();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Failed to assign reviewers");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="outline" size="sm">
          <Users /> Assign reviewers
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Assign {STAGE_LABELS[stage.type].toLowerCase()} screening</DialogTitle>
          <DialogDescription>
            {stage.type === "FULL_TEXT"
              ? "Only citations included at title/abstract are eligible. "
              : "Every active, non-duplicate citation is eligible. "}
            Existing assignments are skipped.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="assign-strategy">Strategy</Label>
            <Select
              id="assign-strategy"
              value={strategy}
              onChange={(e) => setStrategy(e.target.value as "all" | "split")}
            >
              <option value="all">
                Everyone screens every citation
              </option>
              <option value="split">
                Split — {stage.reviewersPerCitation} reviewer(s) per citation, round-robin
              </option>
            </Select>
          </div>

          <div className="space-y-1.5">
            <Label>
              Reviewers{" "}
              <span className="font-normal text-muted-foreground">({reviewerIds.size} selected)</span>
            </Label>
            {members === null ? (
              <p className="rounded-md border border-dashed border-border px-3 py-2 text-sm text-muted-foreground">
                Loading members…
              </p>
            ) : eligible.length === 0 ? (
              <p className="rounded-md border border-dashed border-border px-3 py-2 text-sm text-muted-foreground">
                No active members with screening rights. Add reviewers in project settings first.
              </p>
            ) : (
              <div className="max-h-52 space-y-1 overflow-y-auto rounded-md border border-border p-2">
                {eligible.map((m) => (
                  <label
                    key={m.id}
                    className="flex cursor-pointer items-center gap-2 rounded px-1.5 py-1 text-sm hover:bg-muted"
                  >
                    <input
                      type="checkbox"
                      className="h-4 w-4 accent-primary"
                      checked={reviewerIds.has(m.user.id)}
                      onChange={() => setReviewerIds((prev) => toggle(prev, m.user.id))}
                    />
                    <span className="truncate">{m.user.name}</span>
                    <span className="truncate text-xs text-muted-foreground">{m.user.email}</span>
                  </label>
                ))}
              </div>
            )}
          </div>

          <DialogFooter>
            <Button type="submit" disabled={busy || eligible.length === 0}>
              {busy && <Spinner />} Assign
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
