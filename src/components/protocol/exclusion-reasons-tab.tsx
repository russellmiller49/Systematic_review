"use client";

// Exclusion reasons tab: project-scoped reason CRUD via /exclusion-reasons.
// NOT under the amendment rule — plain mutations. Deleting a reason that is already
// cited by screening decisions deactivates it instead (server decides; we toast which).

import { useCallback, useEffect, useState } from "react";
import { FilterX, Pencil, Plus, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { api, apiDelete, apiPatch, apiPost } from "@/lib/api";
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
import { Alert, EmptyState, Skeleton, Spinner } from "@/components/ui/misc";
import { Select } from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { toastApiError } from "./amendment-gate";
import type { ExclusionReasonRow, ReasonStage } from "./types";
import { parseOrder } from "./types";

const STAGE_LABELS: Record<ReasonStage, string> = {
  TITLE_ABSTRACT: "Title & abstract",
  FULL_TEXT: "Full text",
  BOTH: "Both stages",
};

type DialogState = { mode: "create" } | { mode: "edit"; row: ExclusionReasonRow };

export function ExclusionReasonsTab({ projectId }: { projectId: string }) {
  const [reasons, setReasons] = useState<ExclusionReasonRow[] | null>(null);
  const [dialog, setDialog] = useState<DialogState | null>(null);
  const [formLabel, setFormLabel] = useState("");
  const [formStage, setFormStage] = useState<ReasonStage>("BOTH");
  const [formOrder, setFormOrder] = useState("");
  const [busy, setBusy] = useState(false);
  const [deleting, setDeleting] = useState<ExclusionReasonRow | null>(null);
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [togglingId, setTogglingId] = useState<string | null>(null);

  const load = useCallback(() => {
    api<ExclusionReasonRow[]>(
      `/api/projects/${projectId}/exclusion-reasons?includeInactive=true`,
    )
      .then(setReasons)
      .catch(() => {
        setReasons([]);
        toast.error("Failed to load exclusion reasons");
      });
  }, [projectId]);

  useEffect(load, [load]);

  function openCreate() {
    const nextOrder = reasons?.length
      ? Math.max(...reasons.map((r) => r.order)) + 1
      : 0;
    setFormLabel("");
    setFormStage("BOTH");
    setFormOrder(String(nextOrder));
    setDialog({ mode: "create" });
  }

  function openEdit(row: ExclusionReasonRow) {
    setFormLabel(row.label);
    setFormStage(row.stage);
    setFormOrder(String(row.order));
    setDialog({ mode: "edit", row });
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!dialog) return;
    const orderResult = parseOrder(formOrder);
    if (!orderResult.ok) {
      toast.error("Order must be a non-negative whole number");
      return;
    }
    const target = dialog.mode === "edit" ? dialog.row : null;
    const body = {
      label: formLabel.trim(),
      stage: formStage,
      ...(orderResult.order !== undefined ? { order: orderResult.order } : {}),
    };
    setBusy(true);
    try {
      if (target) {
        await apiPatch(`/api/projects/${projectId}/exclusion-reasons/${target.id}`, body);
      } else {
        await apiPost(`/api/projects/${projectId}/exclusion-reasons`, body);
      }
      toast.success(target ? "Exclusion reason updated" : "Exclusion reason added");
      setDialog(null);
      load();
    } catch (err) {
      toastApiError(err, "Failed to save exclusion reason");
    } finally {
      setBusy(false);
    }
  }

  async function toggleActive(row: ExclusionReasonRow) {
    setTogglingId(row.id);
    try {
      await apiPatch(`/api/projects/${projectId}/exclusion-reasons/${row.id}`, {
        isActive: !row.isActive,
      });
      toast.success(row.isActive ? "Reason deactivated" : "Reason reactivated");
      load();
    } catch (err) {
      toastApiError(err, "Failed to update exclusion reason");
    } finally {
      setTogglingId(null);
    }
  }

  async function confirmDelete() {
    if (!deleting) return;
    setDeleteBusy(true);
    try {
      const result = await apiDelete<{ id: string; deleted: boolean; deactivated: boolean }>(
        `/api/projects/${projectId}/exclusion-reasons/${deleting.id}`,
      );
      toast.success(
        result.deleted
          ? "Exclusion reason deleted"
          : "Reason is cited by screening decisions — deactivated instead",
      );
      setDeleting(null);
      load();
    } catch (err) {
      toastApiError(err, "Failed to delete exclusion reason");
    } finally {
      setDeleteBusy(false);
    }
  }

  return (
    <div className="space-y-4">
      <Alert variant="info">
        Exclusion reasons are the pick-list screeners cite when excluding a study — full-text
        exclusions require one — and they roll up into the PRISMA flow diagram. They are not
        covered by the amendment rule, so they can be edited at any time.
      </Alert>

      <div className="flex items-center justify-between gap-3">
        <p className="text-sm text-muted-foreground">
          Reasons apply at title &amp; abstract screening, full-text screening, or both.
        </p>
        <Button variant="outline" size="sm" onClick={openCreate}>
          <Plus /> Add reason
        </Button>
      </div>

      {reasons === null ? (
        <Skeleton className="h-48" />
      ) : reasons.length === 0 ? (
        <EmptyState
          icon={FilterX}
          title="No exclusion reasons yet"
          description="Define the reasons screeners can cite when excluding a study — they appear in full-text screening and PRISMA counts."
          action={
            <Button variant="outline" size="sm" onClick={openCreate}>
              <Plus /> Add reason
            </Button>
          }
        />
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Label</TableHead>
              <TableHead>Stage</TableHead>
              <TableHead className="w-16">Order</TableHead>
              <TableHead>Status</TableHead>
              <TableHead className="w-56">
                <span className="sr-only">Actions</span>
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {reasons.map((r) => (
              <TableRow key={r.id} className={r.isActive ? undefined : "opacity-60"}>
                <TableCell className="font-medium">{r.label}</TableCell>
                <TableCell className="text-muted-foreground">{STAGE_LABELS[r.stage]}</TableCell>
                <TableCell className="tabular-nums">{r.order}</TableCell>
                <TableCell>
                  <Badge variant={r.isActive ? "include" : "muted"}>
                    {r.isActive ? "active" : "inactive"}
                  </Badge>
                </TableCell>
                <TableCell>
                  <div className="flex items-center justify-end gap-1">
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => void toggleActive(r)}
                      disabled={togglingId === r.id}
                    >
                      {togglingId === r.id && <Spinner />}
                      {r.isActive ? "Deactivate" : "Reactivate"}
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      aria-label="Edit exclusion reason"
                      onClick={() => openEdit(r)}
                    >
                      <Pencil />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      aria-label="Delete exclusion reason"
                      onClick={() => setDeleting(r)}
                    >
                      <Trash2 />
                    </Button>
                  </div>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}

      <Dialog
        open={dialog !== null}
        onOpenChange={(o) => {
          if (!o) setDialog(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {dialog?.mode === "edit" ? "Edit exclusion reason" : "Add exclusion reason"}
            </DialogTitle>
            <DialogDescription>
              Labels must be unique within the project.
            </DialogDescription>
          </DialogHeader>
          <form onSubmit={submit} className="space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="reason-label">Label</Label>
              <Input
                id="reason-label"
                required
                value={formLabel}
                onChange={(e) => setFormLabel(e.target.value)}
                placeholder="e.g. Wrong population"
              />
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-1.5">
                <Label htmlFor="reason-stage">Applies at</Label>
                <Select
                  id="reason-stage"
                  value={formStage}
                  onChange={(e) => setFormStage(e.target.value as ReasonStage)}
                >
                  <option value="BOTH">Both stages</option>
                  <option value="TITLE_ABSTRACT">Title &amp; abstract</option>
                  <option value="FULL_TEXT">Full text</option>
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="reason-order">Order</Label>
                <Input
                  id="reason-order"
                  type="number"
                  min={0}
                  value={formOrder}
                  onChange={(e) => setFormOrder(e.target.value)}
                />
              </div>
            </div>
            <DialogFooter>
              <Button type="submit" disabled={busy || formLabel.trim().length === 0}>
                {busy && <Spinner />}
                {dialog?.mode === "edit" ? "Save changes" : "Add reason"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <Dialog
        open={deleting !== null}
        onOpenChange={(o) => {
          if (!o) setDeleting(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete exclusion reason?</DialogTitle>
            <DialogDescription>
              &ldquo;{deleting?.label}&rdquo; will be removed. If any screening decision already
              cites it, it is deactivated instead of deleted so the record stays intact.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleting(null)} disabled={deleteBusy}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={() => void confirmDelete()}
              disabled={deleteBusy}
            >
              {deleteBusy && <Spinner />} Delete
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
