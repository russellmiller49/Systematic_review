"use client";

// Criteria tab: inclusion/exclusion eligibility criteria CRUD
// (POST /protocol/criteria, PATCH/DELETE /protocol/criteria/[criterionId]).
// All three mutations go through the amendment gate.

import { useState } from "react";
import { ListChecks, Pencil, Plus, Trash2 } from "lucide-react";
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
import { Textarea } from "@/components/ui/textarea";
import type { AmendmentGate } from "./amendment-gate";
import type { CriterionRow, CriterionType, ProtocolDetail } from "./types";
import { apiDeleteWithBody, parseOrder, toNullableText } from "./types";

const TYPE_META: Record<
  CriterionType,
  { title: string; badge: "include" | "exclude"; description: string; emptyTitle: string }
> = {
  INCLUSION: {
    title: "Inclusion criteria",
    badge: "include",
    description: "A study must meet every inclusion criterion to be eligible.",
    emptyTitle: "No inclusion criteria yet",
  },
  EXCLUSION: {
    title: "Exclusion criteria",
    badge: "exclude",
    description: "Meeting any exclusion criterion rules a study out.",
    emptyTitle: "No exclusion criteria yet",
  },
};

type DialogState = { mode: "create"; type: CriterionType } | { mode: "edit"; row: CriterionRow };

export function CriteriaTab({
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
  const [formType, setFormType] = useState<CriterionType>("INCLUSION");
  const [formCategory, setFormCategory] = useState("");
  const [formText, setFormText] = useState("");
  const [formOrder, setFormOrder] = useState("");
  const [busy, setBusy] = useState(false);
  const [deleting, setDeleting] = useState<CriterionRow | null>(null);
  const [deleteBusy, setDeleteBusy] = useState(false);

  function openCreate(type: CriterionType) {
    const siblings = protocol.criteria.filter((c) => c.type === type);
    const nextOrder = siblings.length
      ? Math.max(...siblings.map((c) => c.order)) + 1
      : 0;
    setFormType(type);
    setFormCategory("");
    setFormText("");
    setFormOrder(String(nextOrder));
    setDialog({ mode: "create", type });
  }

  function openEdit(row: CriterionRow) {
    setFormType(row.type);
    setFormCategory(row.category ?? "");
    setFormText(row.text);
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
      type: formType,
      category: toNullableText(formCategory),
      text: formText.trim(),
      ...(orderResult.order !== undefined ? { order: orderResult.order } : {}),
    };
    setBusy(true);
    await gate.guard(
      target ? "Edit eligibility criterion" : "Add eligibility criterion",
      async (fields) => {
        if (target) {
          await apiPatch(`/api/projects/${projectId}/protocol/criteria/${target.id}`, {
            ...body,
            ...fields,
          });
        } else {
          await apiPost(`/api/projects/${projectId}/protocol/criteria`, { ...body, ...fields });
        }
        toast.success(target ? "Criterion updated" : "Criterion added");
        setDialog(null);
        onChanged();
      },
    );
    setBusy(false);
  }

  async function confirmDelete() {
    if (!deleting) return;
    const row = deleting;
    setDeleteBusy(true);
    await gate.guard("Delete eligibility criterion", async (fields) => {
      await apiDeleteWithBody(`/api/projects/${projectId}/protocol/criteria/${row.id}`, fields);
      toast.success("Criterion deleted");
      setDeleting(null);
      onChanged();
    });
    setDeleteBusy(false);
  }

  return (
    <div className="grid items-start gap-4 lg:grid-cols-2">
      {(["INCLUSION", "EXCLUSION"] as const).map((type) => {
        const meta = TYPE_META[type];
        const rows = protocol.criteria.filter((c) => c.type === type);
        return (
          <Card key={type}>
            <CardHeader>
              <div className="flex items-start justify-between gap-3">
                <div>
                  <div className="flex items-center gap-2">
                    <CardTitle className="text-base">{meta.title}</CardTitle>
                    <Badge variant={meta.badge}>{rows.length}</Badge>
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
                  icon={ListChecks}
                  title={meta.emptyTitle}
                  description="Criteria defined here anchor screening decisions and the published protocol."
                />
              ) : (
                <ul className="space-y-2">
                  {rows.map((c) => (
                    <li
                      key={c.id}
                      className="flex items-start justify-between gap-2 rounded-md border border-border p-3"
                    >
                      <div className="min-w-0">
                        <p className="text-sm leading-relaxed">{c.text}</p>
                        <p className="mt-1 text-xs text-muted-foreground">
                          {c.category ? `${c.category} · ` : ""}order {c.order}
                        </p>
                      </div>
                      <div className="flex shrink-0 gap-1">
                        <Button
                          variant="ghost"
                          size="icon"
                          aria-label="Edit criterion"
                          onClick={() => openEdit(c)}
                        >
                          <Pencil />
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon"
                          aria-label="Delete criterion"
                          onClick={() => setDeleting(c)}
                        >
                          <Trash2 />
                        </Button>
                      </div>
                    </li>
                  ))}
                </ul>
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
            <DialogTitle>
              {dialog?.mode === "edit" ? "Edit criterion" : "Add criterion"}
            </DialogTitle>
          </DialogHeader>
          <form onSubmit={submit} className="space-y-4">
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-1.5">
                <Label htmlFor="crit-type">Type</Label>
                <Select
                  id="crit-type"
                  value={formType}
                  onChange={(e) => setFormType(e.target.value as CriterionType)}
                >
                  <option value="INCLUSION">Inclusion</option>
                  <option value="EXCLUSION">Exclusion</option>
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="crit-order">Order</Label>
                <Input
                  id="crit-order"
                  type="number"
                  min={0}
                  value={formOrder}
                  onChange={(e) => setFormOrder(e.target.value)}
                />
              </div>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="crit-category">Category (optional)</Label>
              <Input
                id="crit-category"
                placeholder="e.g. Population, Study design"
                value={formCategory}
                onChange={(e) => setFormCategory(e.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="crit-text">Criterion</Label>
              <Textarea
                id="crit-text"
                rows={3}
                required
                value={formText}
                onChange={(e) => setFormText(e.target.value)}
                placeholder="e.g. Adults (≥18 years) with confirmed diagnosis of …"
              />
            </div>
            <DialogFooter>
              <Button type="submit" disabled={busy || formText.trim().length === 0}>
                {busy && <Spinner />}
                {dialog?.mode === "edit" ? "Save changes" : "Add criterion"}
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
            <DialogTitle>Delete criterion?</DialogTitle>
            <DialogDescription className="line-clamp-3">
              &ldquo;{deleting?.text}&rdquo; will be removed from the protocol. If screening has
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
