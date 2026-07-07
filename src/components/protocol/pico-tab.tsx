"use client";

// PICO tab: structured PICO question CRUD
// (POST /protocol/pico, PATCH/DELETE /protocol/pico/[picoId]).
// All mutations go through the amendment gate.

import { useState } from "react";
import { HelpCircle, Pencil, Plus, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { apiPatch, apiPost } from "@/lib/api";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
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
import { Textarea } from "@/components/ui/textarea";
import type { AmendmentGate } from "./amendment-gate";
import type { PicoRow, ProtocolDetail } from "./types";
import { apiDeleteWithBody, parseOrder, toNullableText } from "./types";

const PICO_PARTS = [
  { key: "population", label: "Population" },
  { key: "intervention", label: "Intervention" },
  { key: "comparator", label: "Comparator" },
  { key: "outcome", label: "Outcome" },
] as const;

type DialogState = { mode: "create" } | { mode: "edit"; row: PicoRow };

export function PicoTab({
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
  const [formQuestion, setFormQuestion] = useState("");
  const [formParts, setFormParts] = useState<Record<string, string>>({});
  const [formOrder, setFormOrder] = useState("");
  const [busy, setBusy] = useState(false);
  const [deleting, setDeleting] = useState<PicoRow | null>(null);
  const [deleteBusy, setDeleteBusy] = useState(false);

  const picos = protocol.picoQuestions;

  function openCreate() {
    const nextOrder = picos.length ? Math.max(...picos.map((q) => q.order)) + 1 : 0;
    setFormQuestion("");
    setFormParts({ population: "", intervention: "", comparator: "", outcome: "" });
    setFormOrder(String(nextOrder));
    setDialog({ mode: "create" });
  }

  function openEdit(row: PicoRow) {
    setFormQuestion(row.question);
    setFormParts({
      population: row.population ?? "",
      intervention: row.intervention ?? "",
      comparator: row.comparator ?? "",
      outcome: row.outcome ?? "",
    });
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
      question: formQuestion.trim(),
      population: toNullableText(formParts.population ?? ""),
      intervention: toNullableText(formParts.intervention ?? ""),
      comparator: toNullableText(formParts.comparator ?? ""),
      outcome: toNullableText(formParts.outcome ?? ""),
      ...(orderResult.order !== undefined ? { order: orderResult.order } : {}),
    };
    setBusy(true);
    await gate.guard(target ? "Edit PICO question" : "Add PICO question", async (fields) => {
      if (target) {
        await apiPatch(`/api/projects/${projectId}/protocol/pico/${target.id}`, {
          ...body,
          ...fields,
        });
      } else {
        await apiPost(`/api/projects/${projectId}/protocol/pico`, { ...body, ...fields });
      }
      toast.success(target ? "PICO question updated" : "PICO question added");
      setDialog(null);
      onChanged();
    });
    setBusy(false);
  }

  async function confirmDelete() {
    if (!deleting) return;
    const row = deleting;
    setDeleteBusy(true);
    await gate.guard("Delete PICO question", async (fields) => {
      await apiDeleteWithBody(`/api/projects/${projectId}/protocol/pico/${row.id}`, fields);
      toast.success("PICO question deleted");
      setDeleting(null);
      onChanged();
    });
    setDeleteBusy(false);
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3">
        <p className="text-sm text-muted-foreground">
          Structured population / intervention / comparator / outcome entries behind the review
          question.
        </p>
        <Button variant="outline" size="sm" onClick={openCreate}>
          <Plus /> Add PICO question
        </Button>
      </div>

      {picos.length === 0 ? (
        <EmptyState
          icon={HelpCircle}
          title="No PICO questions yet"
          description="Break the review question into one or more structured PICO entries."
        />
      ) : (
        <div className="space-y-3">
          {picos.map((q, i) => (
            <Card key={q.id}>
              <CardHeader>
                <div className="flex items-start justify-between gap-3">
                  <div className="flex min-w-0 items-start gap-2">
                    <Badge variant="secondary" className="mt-0.5 shrink-0">
                      Q{i + 1}
                    </Badge>
                    <CardTitle className="text-base leading-snug">{q.question}</CardTitle>
                  </div>
                  <div className="flex shrink-0 gap-1">
                    <Button
                      variant="ghost"
                      size="icon"
                      aria-label="Edit PICO question"
                      onClick={() => openEdit(q)}
                    >
                      <Pencil />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      aria-label="Delete PICO question"
                      onClick={() => setDeleting(q)}
                    >
                      <Trash2 />
                    </Button>
                  </div>
                </div>
              </CardHeader>
              <CardContent>
                <dl className="grid gap-x-6 gap-y-3 sm:grid-cols-2">
                  {PICO_PARTS.map(({ key, label }) => (
                    <div key={key}>
                      <dt className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                        {label}
                      </dt>
                      <dd className="mt-0.5 text-sm">
                        {q[key] ?? <span className="text-muted-foreground">—</span>}
                      </dd>
                    </div>
                  ))}
                </dl>
              </CardContent>
            </Card>
          ))}
        </div>
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
              {dialog?.mode === "edit" ? "Edit PICO question" : "Add PICO question"}
            </DialogTitle>
          </DialogHeader>
          <form onSubmit={submit} className="space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="pico-question">Question</Label>
              <Textarea
                id="pico-question"
                rows={2}
                required
                value={formQuestion}
                onChange={(e) => setFormQuestion(e.target.value)}
                placeholder="In adults with …, does … compared with … improve …?"
              />
            </div>
            <div className="grid grid-cols-2 gap-4">
              {PICO_PARTS.map(({ key, label }) => (
                <div key={key} className="space-y-1.5">
                  <Label htmlFor={`pico-${key}`}>{label}</Label>
                  <Textarea
                    id={`pico-${key}`}
                    rows={2}
                    value={formParts[key] ?? ""}
                    onChange={(e) =>
                      setFormParts((parts) => ({ ...parts, [key]: e.target.value }))
                    }
                  />
                </div>
              ))}
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="pico-order">Order</Label>
              <Input
                id="pico-order"
                type="number"
                min={0}
                value={formOrder}
                onChange={(e) => setFormOrder(e.target.value)}
                className="max-w-32"
              />
            </div>
            <DialogFooter>
              <Button type="submit" disabled={busy || formQuestion.trim().length === 0}>
                {busy && <Spinner />}
                {dialog?.mode === "edit" ? "Save changes" : "Add PICO question"}
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
            <DialogTitle>Delete PICO question?</DialogTitle>
            <DialogDescription className="line-clamp-3">
              &ldquo;{deleting?.question}&rdquo; will be removed from the protocol. If screening
              has begun you will be asked to record an amendment.
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
