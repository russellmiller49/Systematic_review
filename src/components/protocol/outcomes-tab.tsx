"use client";

// Outcomes tab: primary/secondary outcome definitions CRUD
// (POST /protocol/outcomes, PATCH/DELETE /protocol/outcomes/[outcomeId]).
// All mutations go through the amendment gate.

import { useState } from "react";
import { Pencil, Plus, Target, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { apiPatch, apiPost } from "@/lib/api";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
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
import { EmptyState, Spinner } from "@/components/ui/misc";
import { Select } from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import type { AmendmentGate } from "./amendment-gate";
import type { OutcomeRow, OutcomeType, ProtocolDetail } from "./types";
import { apiDeleteWithBody, parseOrder, toNullableText } from "./types";

const TYPE_META: Record<OutcomeType, { title: string; description: string; emptyTitle: string }> =
  {
    PRIMARY: {
      title: "Primary outcomes",
      description: "The outcomes this review is powered to answer.",
      emptyTitle: "No primary outcomes yet",
    },
    SECONDARY: {
      title: "Secondary outcomes",
      description: "Additional outcomes of interest.",
      emptyTitle: "No secondary outcomes yet",
    },
  };

type DialogState = { mode: "create"; type: OutcomeType } | { mode: "edit"; row: OutcomeRow };

export function OutcomesTab({
  projectId,
  protocol,
  gate,
  onChanged,
}: {
  projectId: string;
  protocol: ProtocolDetail;
  gate: AmendmentGate;
  onChanged: () => void;
}) {
  const [dialog, setDialog] = useState<DialogState | null>(null);
  const [formName, setFormName] = useState("");
  const [formType, setFormType] = useState<OutcomeType>("PRIMARY");
  const [formMeasure, setFormMeasure] = useState("");
  const [formTimepoint, setFormTimepoint] = useState("");
  const [formOrder, setFormOrder] = useState("");
  const [busy, setBusy] = useState(false);
  const [deleting, setDeleting] = useState<OutcomeRow | null>(null);
  const [deleteBusy, setDeleteBusy] = useState(false);

  function openCreate(type: OutcomeType) {
    const siblings = protocol.outcomes.filter((o) => o.type === type);
    const nextOrder = siblings.length ? Math.max(...siblings.map((o) => o.order)) + 1 : 0;
    setFormName("");
    setFormType(type);
    setFormMeasure("");
    setFormTimepoint("");
    setFormOrder(String(nextOrder));
    setDialog({ mode: "create", type });
  }

  function openEdit(row: OutcomeRow) {
    setFormName(row.name);
    setFormType(row.type);
    setFormMeasure(row.measure ?? "");
    setFormTimepoint(row.timepoint ?? "");
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
      name: formName.trim(),
      type: formType,
      measure: toNullableText(formMeasure),
      timepoint: toNullableText(formTimepoint),
      ...(orderResult.order !== undefined ? { order: orderResult.order } : {}),
    };
    setBusy(true);
    await gate.guard(target ? "Edit outcome" : "Add outcome", async (fields) => {
      if (target) {
        await apiPatch(`/api/projects/${projectId}/protocol/outcomes/${target.id}`, {
          ...body,
          ...fields,
        });
      } else {
        await apiPost(`/api/projects/${projectId}/protocol/outcomes`, { ...body, ...fields });
      }
      toast.success(target ? "Outcome updated" : "Outcome added");
      setDialog(null);
      onChanged();
    });
    setBusy(false);
  }

  async function confirmDelete() {
    if (!deleting) return;
    const row = deleting;
    setDeleteBusy(true);
    await gate.guard("Delete outcome", async (fields) => {
      await apiDeleteWithBody(`/api/projects/${projectId}/protocol/outcomes/${row.id}`, fields);
      toast.success("Outcome deleted");
      setDeleting(null);
      onChanged();
    });
    setDeleteBusy(false);
  }

  return (
    <div className="space-y-4">
      {(["PRIMARY", "SECONDARY"] as const).map((type) => {
        const meta = TYPE_META[type];
        const rows = protocol.outcomes.filter((o) => o.type === type);
        return (
          <Card key={type}>
            <CardHeader>
              <div className="flex items-start justify-between gap-3">
                <div>
                  <div className="flex items-center gap-2">
                    <CardTitle className="text-base">{meta.title}</CardTitle>
                    <Badge variant="secondary">{rows.length}</Badge>
                  </div>
                  <CardDescription className="mt-1">{meta.description}</CardDescription>
                </div>
                <Button variant="outline" size="sm" onClick={() => openCreate(type)}>
                  <Plus /> Add
                </Button>
              </div>
            </CardHeader>
            <CardContent>
              {rows.length === 0 ? (
                <EmptyState
                  icon={Target}
                  title={meta.emptyTitle}
                  description="Outcomes defined here anchor extraction forms and future synthesis."
                />
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Name</TableHead>
                      <TableHead>Measure</TableHead>
                      <TableHead>Timepoint</TableHead>
                      <TableHead className="w-16">Order</TableHead>
                      <TableHead className="w-24">
                        <span className="sr-only">Actions</span>
                      </TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {rows.map((o) => (
                      <TableRow key={o.id}>
                        <TableCell className="font-medium">{o.name}</TableCell>
                        <TableCell className="text-muted-foreground">
                          {o.measure ?? "—"}
                        </TableCell>
                        <TableCell className="text-muted-foreground">
                          {o.timepoint ?? "—"}
                        </TableCell>
                        <TableCell className="tabular-nums">{o.order}</TableCell>
                        <TableCell>
                          <div className="flex justify-end gap-1">
                            <Button
                              variant="ghost"
                              size="icon"
                              aria-label="Edit outcome"
                              onClick={() => openEdit(o)}
                            >
                              <Pencil />
                            </Button>
                            <Button
                              variant="ghost"
                              size="icon"
                              aria-label="Delete outcome"
                              onClick={() => setDeleting(o)}
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
            </CardContent>
          </Card>
        );
      })}

      <Dialog
        open={dialog !== null}
        onOpenChange={(o) => {
          if (!o) setDialog(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{dialog?.mode === "edit" ? "Edit outcome" : "Add outcome"}</DialogTitle>
          </DialogHeader>
          <form onSubmit={submit} className="space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="out-name">Name</Label>
              <Input
                id="out-name"
                required
                value={formName}
                onChange={(e) => setFormName(e.target.value)}
                placeholder="e.g. All-cause mortality"
              />
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-1.5">
                <Label htmlFor="out-type">Type</Label>
                <Select
                  id="out-type"
                  value={formType}
                  onChange={(e) => setFormType(e.target.value as OutcomeType)}
                >
                  <option value="PRIMARY">Primary</option>
                  <option value="SECONDARY">Secondary</option>
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="out-order">Order</Label>
                <Input
                  id="out-order"
                  type="number"
                  min={0}
                  value={formOrder}
                  onChange={(e) => setFormOrder(e.target.value)}
                />
              </div>
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-1.5">
                <Label htmlFor="out-measure">Measure (optional)</Label>
                <Input
                  id="out-measure"
                  value={formMeasure}
                  onChange={(e) => setFormMeasure(e.target.value)}
                  placeholder="e.g. RR, MD, proportion"
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="out-timepoint">Timepoint (optional)</Label>
                <Input
                  id="out-timepoint"
                  value={formTimepoint}
                  onChange={(e) => setFormTimepoint(e.target.value)}
                  placeholder="e.g. 12 months"
                />
              </div>
            </div>
            <DialogFooter>
              <Button type="submit" disabled={busy || formName.trim().length === 0}>
                {busy && <Spinner />}
                {dialog?.mode === "edit" ? "Save changes" : "Add outcome"}
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
            <DialogTitle>Delete outcome?</DialogTitle>
            <DialogDescription className="line-clamp-3">
              &ldquo;{deleting?.name}&rdquo; will be removed from the protocol. If screening has
              begun you will be asked to record an amendment.
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
