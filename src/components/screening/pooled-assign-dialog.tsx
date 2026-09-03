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

const SCREENING_ROLES = new Set(["OWNER", "ADMIN", "REVIEWER", "ADJUDICATOR", "TRAINEE"]);

interface MemberRow {
  id: string;
  roles: string[];
  status: string;
  user: { id: string; name: string; email: string };
}
function toggle(current: Set<string>, id: string): Set<string> {
  const next = new Set(current);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  return next;
}

export function PooledAssignDialog({
  guidelineId,
  projectIds,
  reviewersPerCitation,
  onAssigned,
}: {
  guidelineId: string;
  projectIds: string[];
  reviewersPerCitation: number;
  onAssigned: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [members, setMembers] = useState<MemberRow[] | null>(null);
  const [reviewerIds, setReviewerIds] = useState<Set<string>>(new Set());
  const [strategy, setStrategy] = useState<"all" | "split">("all");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    api<MemberRow[]>(`/api/projects/${guidelineId}/members`)
      .then(setMembers)
      .catch(() => setMembers([]));
  }, [guidelineId, open]);

  const eligible = useMemo(
    () =>
      (members ?? []).filter(
        (member) =>
          member.status === "ACTIVE" &&
          member.roles.some((role) => SCREENING_ROLES.has(role)),
      ),
    [members],
  );

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (reviewerIds.size === 0) {
      toast.error("Select at least one reviewer");
      return;
    }
    if (strategy === "split" && reviewerIds.size < reviewersPerCitation) {
      toast.error(`Split assignment needs at least ${reviewersPerCitation} reviewers`);
      return;
    }
    setBusy(true);
    try {
      const result = await apiPost<{
        created: number;
        skippedExisting: number;
        eligibleAbstracts: number;
        linkedCitationRecords: number;
      }>(`/api/projects/${guidelineId}/screening/pooled/assignments`, {
        projectIds,
        reviewerIds: [...reviewerIds],
        strategy,
      });
      toast.success(
        `${result.created.toLocaleString()} pooled assignment${result.created === 1 ? "" : "s"} created`,
        {
          description:
            `${result.eligibleAbstracts.toLocaleString()} unique abstracts across ` +
            `${result.linkedCitationRecords.toLocaleString()} PICO citation records. ` +
            `${result.skippedExisting.toLocaleString()} existing pairs skipped.`,
        },
      );
      setOpen(false);
      setReviewerIds(new Set());
      onAssigned();
    } catch (error) {
      toast.error(error instanceof ApiError ? error.message : "Failed to assign pooled screening");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="outline" size="sm" disabled={projectIds.length < 2}>
          <Users /> Assign pooled reviewers
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Assign the combined abstract pool</DialogTitle>
          <DialogDescription>
            The same reviewer set is assigned to every copy of an abstract across the selected
            PICOs. This keeps one combined decision synchronized across the guideline family.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="pooled-assign-strategy">Strategy</Label>
            <Select
              id="pooled-assign-strategy"
              value={strategy}
              onChange={(event) => setStrategy(event.target.value as "all" | "split")}
            >
              <option value="all">Everyone screens every pooled abstract</option>
              <option value="split">
                Split — {reviewersPerCitation} reviewer(s) per abstract, round-robin
              </option>
            </Select>
          </div>

          <div className="space-y-1.5">
            <Label>
              Reviewers{" "}
              <span className="font-normal text-muted-foreground">
                ({reviewerIds.size} selected)
              </span>
            </Label>
            {members === null ? (
              <p className="rounded-md border border-dashed border-border px-3 py-2 text-sm text-muted-foreground">
                Loading members…
              </p>
            ) : eligible.length === 0 ? (
              <p className="rounded-md border border-dashed border-border px-3 py-2 text-sm text-muted-foreground">
                No active guideline members have screening rights.
              </p>
            ) : (
              <div className="max-h-52 space-y-1 overflow-y-auto rounded-md border border-border p-2">
                {eligible.map((member) => (
                  <label
                    key={member.id}
                    className="flex cursor-pointer items-center gap-2 rounded px-1.5 py-1 text-sm hover:bg-muted"
                  >
                    <input
                      type="checkbox"
                      className="h-4 w-4 accent-primary"
                      checked={reviewerIds.has(member.user.id)}
                      onChange={() =>
                        setReviewerIds((current) => toggle(current, member.user.id))
                      }
                    />
                    <span className="truncate">{member.user.name}</span>
                    <span className="truncate text-xs text-muted-foreground">
                      {member.user.email}
                    </span>
                  </label>
                ))}
              </div>
            )}
          </div>

          <DialogFooter>
            <Button type="submit" disabled={busy || eligible.length === 0}>
              {busy && <Spinner />} Assign combined pool
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
