"use client";

import { useState } from "react";
import { Plus, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { apiPost, ApiError } from "@/lib/api";
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
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Spinner } from "@/components/ui/misc";

interface ScaleRow {
  label: string;
  color: string;
}

const DEFAULT_ROWS: ScaleRow[] = [
  { label: "Low risk", color: "#16a34a" },
  { label: "Some concerns", color: "#d97706" },
  { label: "High risk", color: "#dc2626" },
];

// Scale values must be snake_case identifiers starting with a letter (server rule).
function toValue(label: string): string {
  return label
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^[^a-z]+/, "")
    .replace(/_+$/, "");
}

export function CreateToolDialog({
  projectId,
  onCreated,
}: {
  projectId: string;
  onCreated: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [rows, setRows] = useState<ScaleRow[]>(DEFAULT_ROWS);
  const [busy, setBusy] = useState(false);

  function setRow(index: number, patch: Partial<ScaleRow>) {
    setRows((prev) => prev.map((r, i) => (i === index ? { ...r, ...patch } : r)));
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const scale = rows.map((r) => ({
      value: toValue(r.label),
      label: r.label.trim(),
      color: r.color,
    }));
    if (scale.length < 2) {
      toast.error("A judgment scale needs at least two levels");
      return;
    }
    if (scale.some((s) => s.label.length === 0 || !/^[a-z][a-z0-9_]*$/.test(s.value))) {
      toast.error("Every scale level needs a label starting with a letter");
      return;
    }
    if (new Set(scale.map((s) => s.value)).size !== scale.length) {
      toast.error("Scale level labels must be distinct");
      return;
    }
    setBusy(true);
    try {
      await apiPost(`/api/projects/${projectId}/rob/tools`, {
        name: name.trim(),
        ...(description.trim() ? { description: description.trim() } : {}),
        judgmentScale: scale,
      });
      toast.success("Tool created — add domains, then publish it");
      setOpen(false);
      setName("");
      setDescription("");
      setRows(DEFAULT_ROWS);
      onCreated();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Failed to create tool");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="sm">
          <Plus /> New tool
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle>New risk-of-bias tool</DialogTitle>
          <DialogDescription>
            Define the judgment scale now; add domains and signaling questions while the tool is a
            draft, then publish it.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="tool-name">Name</Label>
            <Input
              id="tool-name"
              required
              minLength={2}
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Modified NOS for cohort studies"
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="tool-desc">Description (optional)</Label>
            <Textarea
              id="tool-desc"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="When to use this tool"
            />
          </div>
          <div className="space-y-1.5">
            <Label>Judgment scale</Label>
            <p className="text-xs text-muted-foreground">
              Each level gets a label and a color used across pickers and the summary table.
            </p>
            <div className="space-y-2">
              {rows.map((row, i) => (
                <div key={i} className="flex items-center gap-2">
                  <Input
                    value={row.label}
                    onChange={(e) => setRow(i, { label: e.target.value })}
                    placeholder={`Level ${i + 1} label`}
                    aria-label={`Scale level ${i + 1} label`}
                  />
                  <input
                    type="color"
                    value={row.color}
                    onChange={(e) => setRow(i, { color: e.target.value })}
                    aria-label={`Scale level ${i + 1} color`}
                    className="h-9 w-11 shrink-0 cursor-pointer rounded-md border border-input bg-background p-1"
                  />
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    disabled={rows.length <= 2}
                    onClick={() => setRows((prev) => prev.filter((_, j) => j !== i))}
                    aria-label={`Remove scale level ${i + 1}`}
                  >
                    <Trash2 />
                  </Button>
                </div>
              ))}
            </div>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => setRows((prev) => [...prev, { label: "", color: "#64748b" }])}
            >
              <Plus /> Add level
            </Button>
          </div>
          <DialogFooter>
            <Button type="submit" disabled={busy}>
              {busy && <Spinner />} Create tool
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
