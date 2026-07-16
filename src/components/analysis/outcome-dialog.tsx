"use client";

// Create/edit dialog for an analysis outcome. The effect measure is immutable after
// creation (it determines the required statistical roles and the pooling scale), so
// the measure select is disabled when editing. Delete lives here too, behind an
// in-dialog confirm step — deleting removes mappings + manual exclusions only;
// results are recomputed from extraction data, never stored.

import { useEffect, useState } from "react";
import { Trash2 } from "lucide-react";
import { toast } from "sonner";
import { apiDelete, apiPatch, apiPost } from "@/lib/api";
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
import { Alert, Spinner } from "@/components/ui/misc";
import { Select } from "@/components/ui/select";
import {
  apiErrorMessages,
  MEASURE_OPTIONS,
  type AnalysisOutcomeRow,
  type EffectDirection,
  type EffectMeasure,
  type GroupLabels,
  type PoolingModel,
  type ProtocolOutcomeOption,
} from "./types";

export type OutcomeDialogState =
  | { mode: "create" }
  | { mode: "edit"; outcome: AnalysisOutcomeRow };

export function OutcomeDialog({
  projectId,
  state,
  protocolOutcomes,
  onClose,
  onSaved,
  onDeleted,
}: {
  projectId: string;
  state: OutcomeDialogState | null;
  protocolOutcomes: ProtocolOutcomeOption[];
  onClose: () => void;
  onSaved: (row: AnalysisOutcomeRow) => void;
  onDeleted: (outcomeId: string) => void;
}) {
  const [name, setName] = useState("");
  const [measure, setMeasure] = useState<EffectMeasure>("RR");
  const [timepoint, setTimepoint] = useState("");
  const [direction, setDirection] = useState<EffectDirection>("LOWER_IS_BETTER");
  const [model, setModel] = useState<PoolingModel>("RANDOM");
  const [g1, setG1] = useState("");
  const [g2, setG2] = useState("");
  const [anchorId, setAnchorId] = useState("");
  const [busy, setBusy] = useState(false);
  const [errors, setErrors] = useState<string[]>([]);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleteBusy, setDeleteBusy] = useState(false);

  const editing = state?.mode === "edit";

  // Reset the form whenever the dialog (re)opens.
  useEffect(() => {
    if (!state) return;
    if (state.mode === "edit") {
      const o = state.outcome;
      setName(o.name);
      setMeasure(o.measure);
      setTimepoint(o.timepoint ?? "");
      setDirection(o.direction);
      setModel(o.model);
      setG1(o.groupLabels?.g1 ?? "");
      setG2(o.groupLabels?.g2 ?? "");
      setAnchorId(o.outcomeDefinitionId ?? "");
    } else {
      setName("");
      setMeasure("RR");
      setTimepoint("");
      setDirection("LOWER_IS_BETTER");
      setModel("RANDOM");
      setG1("");
      setG2("");
      setAnchorId("");
    }
    setErrors([]);
    setConfirmDelete(false);
  }, [state]);

  // Picking a protocol anchor prefills empty name/timepoint on create.
  function pickAnchor(id: string) {
    setAnchorId(id);
    if (state?.mode !== "create" || !id) return;
    const anchor = protocolOutcomes.find((po) => po.id === id);
    if (!anchor) return;
    if (!name.trim()) setName(anchor.name);
    if (!timepoint.trim() && anchor.timepoint) setTimepoint(anchor.timepoint);
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!state) return;
    const trimmedName = name.trim();
    if (!trimmedName) return;
    const labels: GroupLabels = {};
    if (g1.trim()) labels.g1 = g1.trim();
    if (g2.trim()) labels.g2 = g2.trim();
    const hasLabels = labels.g1 !== undefined || labels.g2 !== undefined;
    setBusy(true);
    setErrors([]);
    try {
      let saved: AnalysisOutcomeRow;
      if (state.mode === "edit") {
        saved = await apiPatch<AnalysisOutcomeRow>(
          `/api/projects/${projectId}/analysis/outcomes/${state.outcome.id}`,
          {
            name: trimmedName,
            timepoint: timepoint.trim() || null,
            direction,
            model,
            groupLabels: hasLabels ? labels : null,
            outcomeDefinitionId: anchorId || null,
          },
        );
        toast.success("Outcome updated");
      } else {
        saved = await apiPost<AnalysisOutcomeRow>(`/api/projects/${projectId}/analysis/outcomes`, {
          name: trimmedName,
          measure,
          ...(timepoint.trim() ? { timepoint: timepoint.trim() } : {}),
          direction,
          model,
          ...(hasLabels ? { groupLabels: labels } : {}),
          ...(anchorId ? { outcomeDefinitionId: anchorId } : {}),
        });
        toast.success("Outcome created");
      }
      onSaved(saved);
    } catch (err) {
      setErrors(apiErrorMessages(err));
    } finally {
      setBusy(false);
    }
  }

  async function confirmDeleteNow() {
    if (state?.mode !== "edit") return;
    setDeleteBusy(true);
    try {
      await apiDelete<{ deleted: boolean }>(
        `/api/projects/${projectId}/analysis/outcomes/${state.outcome.id}`,
      );
      toast.success("Outcome deleted");
      onDeleted(state.outcome.id);
    } catch (err) {
      setErrors(apiErrorMessages(err));
    } finally {
      setDeleteBusy(false);
    }
  }

  return (
    <Dialog
      open={state !== null}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{editing ? "Edit outcome" : "New analysis outcome"}</DialogTitle>
          <DialogDescription>
            {editing
              ? "The effect measure is fixed after creation — create a new outcome to analyse a different measure."
              : "Pick the effect measure carefully: it determines which extraction values the outcome needs and cannot be changed later."}
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={(e) => void submit(e)} className="space-y-4">
          {errors.length > 0 && (
            <Alert variant="error">
              <ul className="list-inside list-disc space-y-0.5">
                {errors.map((m) => (
                  <li key={m}>{m}</li>
                ))}
              </ul>
            </Alert>
          )}
          <div className="space-y-1.5">
            <Label htmlFor="ao-name">Name</Label>
            <Input
              id="ao-name"
              required
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. All-cause mortality"
            />
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-1.5">
              <Label htmlFor="ao-measure">Effect measure</Label>
              <Select
                id="ao-measure"
                value={measure}
                disabled={editing}
                onChange={(e) => setMeasure(e.target.value as EffectMeasure)}
              >
                {MEASURE_OPTIONS.map((opt) => (
                  <option key={opt.value} value={opt.value}>
                    {opt.label}
                  </option>
                ))}
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="ao-timepoint">Timepoint (optional)</Label>
              <Input
                id="ao-timepoint"
                value={timepoint}
                onChange={(e) => setTimepoint(e.target.value)}
                placeholder="e.g. 12 months"
              />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-1.5">
              <Label htmlFor="ao-direction">Direction</Label>
              <Select
                id="ao-direction"
                value={direction}
                onChange={(e) => setDirection(e.target.value as EffectDirection)}
              >
                <option value="LOWER_IS_BETTER">Lower is better (e.g. mortality)</option>
                <option value="HIGHER_IS_BETTER">Higher is better (e.g. cure)</option>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="ao-model">Default model</Label>
              <Select
                id="ao-model"
                value={model}
                onChange={(e) => setModel(e.target.value as PoolingModel)}
              >
                <option value="RANDOM">Random effects (DerSimonian–Laird)</option>
                <option value="FIXED">Fixed effect (inverse variance)</option>
              </Select>
            </div>
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-1.5">
              <Label htmlFor="ao-g1">Group 1 label</Label>
              <Input
                id="ao-g1"
                value={g1}
                onChange={(e) => setG1(e.target.value)}
                placeholder="e.g. Intervention"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="ao-g2">Group 2 label</Label>
              <Input
                id="ao-g2"
                value={g2}
                onChange={(e) => setG2(e.target.value)}
                placeholder="e.g. Control"
              />
            </div>
          </div>
          {protocolOutcomes.length > 0 && (
            <div className="space-y-1.5">
              <Label htmlFor="ao-anchor">Protocol outcome (optional)</Label>
              <Select id="ao-anchor" value={anchorId} onChange={(e) => pickAnchor(e.target.value)}>
                <option value="">None</option>
                {protocolOutcomes.map((po) => (
                  <option key={po.id} value={po.id}>
                    {po.name}
                    {po.timepoint ? ` — ${po.timepoint}` : ""}
                  </option>
                ))}
              </Select>
              <p className="text-xs text-muted-foreground">
                Anchoring links this analysis to a pre-specified protocol outcome.
              </p>
            </div>
          )}

          {state?.mode === "edit" && (
            <div className="rounded-md border border-exclude/30 p-3">
              {confirmDelete ? (
                <div className="space-y-2">
                  <p className="text-sm">
                    Delete &ldquo;{state.outcome.name}&rdquo;? Its role mappings and manual study
                    exclusions go with it. Extracted data is untouched — results are recomputed,
                    never stored.
                  </p>
                  <div className="flex justify-end gap-2">
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => setConfirmDelete(false)}
                      disabled={deleteBusy}
                    >
                      Cancel
                    </Button>
                    <Button
                      variant="destructive"
                      size="sm"
                      onClick={() => void confirmDeleteNow()}
                      disabled={deleteBusy}
                    >
                      {deleteBusy && <Spinner />} Delete outcome
                    </Button>
                  </div>
                </div>
              ) : (
                <div className="flex items-center justify-between gap-3">
                  <p className="text-sm text-muted-foreground">
                    Remove this outcome and its mappings.
                  </p>
                  <Button
                    variant="outline"
                    size="sm"
                    className="text-exclude"
                    onClick={() => setConfirmDelete(true)}
                  >
                    <Trash2 /> Delete
                  </Button>
                </div>
              )}
            </div>
          )}

          <DialogFooter>
            <Button variant="outline" onClick={onClose} disabled={busy}>
              Cancel
            </Button>
            <Button type="submit" disabled={busy || name.trim().length === 0}>
              {busy && <Spinner />}
              {editing ? "Save changes" : "Create outcome"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
