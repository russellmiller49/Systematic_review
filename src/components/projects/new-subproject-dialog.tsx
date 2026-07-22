"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Plus } from "lucide-react";
import { toast } from "sonner";
import { apiPost, ApiError } from "@/lib/api";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Spinner } from "@/components/ui/misc";

// Adds a PICO question to a guideline as a full sub-project. The guideline's team and
// screening configuration carry over; everything can be tuned in the sub-project after.
export function NewSubProjectDialog({
  projectId,
  onCreated,
}: {
  projectId: string;
  onCreated?: () => void;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [form, setForm] = useState({ title: "", researchQuestion: "", description: "" });

  function set<K extends keyof typeof form>(key: K, value: (typeof form)[K]) {
    setForm((f) => ({ ...f, [key]: value }));
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      const project = await apiPost<{ id: string }>(`/api/projects/${projectId}/subprojects`, {
        title: form.title,
        researchQuestion: form.researchQuestion,
        description: form.description || undefined,
      });
      toast.success("PICO sub-project created");
      setOpen(false);
      onCreated?.();
      router.push(`/projects/${project.id}`);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Failed to create sub-project");
      setBusy(false);
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (next) {
          setBusy(false);
          setForm({ title: "", researchQuestion: "", description: "" });
        }
      }}
    >
      <DialogTrigger asChild>
        <Button>
          <Plus /> Add PICO question
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle>Add a PICO question</DialogTitle>
          <DialogDescription>
            Each PICO question becomes its own review sub-project with the full workflow —
            protocol, screening, extraction, analysis, and its manuscript sections. The
            guideline team and screening settings are copied in, and the reference library
            is shared with the guideline.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="sp-title">Short title</Label>
            <Input
              id="sp-title"
              required
              value={form.title}
              onChange={(e) => set("title", e.target.value)}
              placeholder="e.g. PICO 1 — Valves vs standard care"
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="sp-q">PICO question</Label>
            <Textarea
              id="sp-q"
              required
              value={form.researchQuestion}
              onChange={(e) => set("researchQuestion", e.target.value)}
              placeholder="In adults with X (P), does Y (I) compared with Z (C) improve … (O)?"
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="sp-desc">Description (optional)</Label>
            <Textarea
              id="sp-desc"
              value={form.description}
              onChange={(e) => set("description", e.target.value)}
            />
          </div>
          <DialogFooter>
            <Button type="submit" disabled={busy}>
              {busy && <Spinner />} Create sub-project
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
