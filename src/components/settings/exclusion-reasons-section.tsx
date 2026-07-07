"use client";

import { useCallback, useEffect, useState } from "react";
import { ListX, Pencil, Plus, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { api, apiDelete, apiPatch, apiPost, ApiError } from "@/lib/api";
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

interface ReasonRow {
  id: string;
  label: string;
  stage: "TITLE_ABSTRACT" | "FULL_TEXT" | "BOTH";
  order: number;
  isActive: boolean;
}

// DELETE hard-deletes unreferenced reasons; reasons cited by decisions are deactivated.
interface DeleteReasonResult {
  id: string;
  deleted: boolean;
  deactivated: boolean;
}

const STAGE_LABELS: Record<ReasonRow["stage"], string> = {
  TITLE_ABSTRACT: "Title & abstract",
  FULL_TEXT: "Full text",
  BOTH: "Both stages",
};

export function ExclusionReasonsSection({
  projectId,
  canEdit,
}: {
  projectId: string;
  canEdit: boolean;
}) {
  const [reasons, setReasons] = useState<ReasonRow[] | null>(null);

  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<ReasonRow | null>(null);
  const [label, setLabel] = useState("");
  const [stage, setStage] = useState<string>("BOTH");
  const [order, setOrder] = useState("0");
  const [isActive, setIsActive] = useState(true);
  const [saving, setSaving] = useState(false);

  const [deleteTarget, setDeleteTarget] = useState<ReasonRow | null>(null);
  const [deleting, setDeleting] = useState(false);

  const load = useCallback(() => {
    api<ReasonRow[]>(`/api/projects/${projectId}/exclusion-reasons?includeInactive=true`)
      .then(setReasons)
      .catch(() => {
        toast.error("Failed to load exclusion reasons");
        setReasons([]);
      });
  }, [projectId]);

  useEffect(load, [load]);

  function openAdd() {
    setEditing(null);
    setLabel("");
    setStage("BOTH");
    setOrder("0");
    setIsActive(true);
    setFormOpen(true);
  }

  function openEdit(reason: ReasonRow) {
    setEditing(reason);
    setLabel(reason.label);
    setStage(reason.stage);
    setOrder(String(reason.order));
    setIsActive(reason.isActive);
    setFormOpen(true);
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    try {
      const parsedOrder = Number.parseInt(order, 10);
      const body = {
        label: label.trim(),
        stage,
        order: Number.isNaN(parsedOrder) ? 0 : Math.max(0, parsedOrder),
      };
      if (editing) {
        await apiPatch(`/api/projects/${projectId}/exclusion-reasons/${editing.id}`, {
          ...body,
          isActive,
        });
        toast.success("Exclusion reason updated");
      } else {
        await apiPost(`/api/projects/${projectId}/exclusion-reasons`, body);
        toast.success("Exclusion reason added");
      }
      setFormOpen(false);
      load();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Failed to save exclusion reason");
    } finally {
      setSaving(false);
    }
  }

  async function deleteReason() {
    if (!deleteTarget) return;
    setDeleting(true);
    try {
      const result = await apiDelete<DeleteReasonResult>(
        `/api/projects/${projectId}/exclusion-reasons/${deleteTarget.id}`,
      );
      toast.success(
        result.deleted
          ? "Exclusion reason deleted"
          : "Reason is cited by existing decisions — deactivated instead",
      );
      setDeleteTarget(null);
      load();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Failed to delete exclusion reason");
    } finally {
      setDeleting(false);
    }
  }

  return (
    <section className="space-y-3">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-lg font-medium">Exclusion reasons</h2>
          <p className="text-sm text-muted-foreground">
            The reasons reviewers can cite when excluding a citation.
          </p>
        </div>
        {canEdit && (
          <Button variant="outline" size="sm" onClick={openAdd}>
            <Plus /> Add reason
          </Button>
        )}
      </div>

      {reasons === null ? (
        <Skeleton className="h-32" />
      ) : reasons.length === 0 ? (
        <EmptyState
          icon={ListX}
          title="No exclusion reasons"
          description="Define reasons (e.g. wrong population, wrong study design) so excluded citations carry a documented rationale."
        />
      ) : (
        <div className="rounded-lg border border-border bg-card">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Label</TableHead>
                <TableHead>Applies to</TableHead>
                <TableHead>Order</TableHead>
                <TableHead>Status</TableHead>
                {canEdit && <TableHead className="w-24" />}
              </TableRow>
            </TableHeader>
            <TableBody>
              {reasons.map((reason) => (
                <TableRow key={reason.id}>
                  <TableCell className="font-medium">{reason.label}</TableCell>
                  <TableCell>
                    <Badge variant="outline">{STAGE_LABELS[reason.stage]}</Badge>
                  </TableCell>
                  <TableCell className="tabular-nums text-muted-foreground">
                    {reason.order}
                  </TableCell>
                  <TableCell>
                    <Badge variant={reason.isActive ? "include" : "muted"}>
                      {reason.isActive ? "active" : "inactive"}
                    </Badge>
                  </TableCell>
                  {canEdit && (
                    <TableCell>
                      <div className="flex justify-end gap-1">
                        <Button
                          variant="ghost"
                          size="icon"
                          title="Edit reason"
                          onClick={() => openEdit(reason)}
                        >
                          <Pencil />
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon"
                          title="Delete reason"
                          onClick={() => setDeleteTarget(reason)}
                        >
                          <Trash2 />
                        </Button>
                      </div>
                    </TableCell>
                  )}
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}

      <Dialog open={formOpen} onOpenChange={setFormOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{editing ? "Edit exclusion reason" : "Add exclusion reason"}</DialogTitle>
          </DialogHeader>
          <form onSubmit={submit} className="space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="er-label">Label</Label>
              <Input
                id="er-label"
                required
                maxLength={300}
                value={label}
                onChange={(e) => setLabel(e.target.value)}
              />
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label htmlFor="er-stage">Applies to</Label>
                <Select id="er-stage" value={stage} onChange={(e) => setStage(e.target.value)}>
                  <option value="BOTH">Both stages</option>
                  <option value="TITLE_ABSTRACT">Title &amp; abstract</option>
                  <option value="FULL_TEXT">Full text</option>
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="er-order">Order</Label>
                <Input
                  id="er-order"
                  type="number"
                  min={0}
                  value={order}
                  onChange={(e) => setOrder(e.target.value)}
                />
              </div>
            </div>
            {editing && (
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  className="h-4 w-4 accent-primary"
                  checked={isActive}
                  onChange={(e) => setIsActive(e.target.checked)}
                />
                Active — selectable by reviewers
              </label>
            )}
            <DialogFooter>
              <Button type="submit" disabled={saving}>
                {saving && <Spinner />} {editing ? "Save changes" : "Add reason"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <Dialog
        open={deleteTarget !== null}
        onOpenChange={(open) => !open && setDeleteTarget(null)}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete &ldquo;{deleteTarget?.label}&rdquo;?</DialogTitle>
            <DialogDescription>
              If the reason is already cited by screening decisions it is deactivated instead
              of deleted, so the record stays intact.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleteTarget(null)}>
              Cancel
            </Button>
            <Button variant="destructive" onClick={deleteReason} disabled={deleting}>
              {deleting && <Spinner />} Delete
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  );
}
