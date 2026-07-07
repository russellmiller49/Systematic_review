"use client";

import { useEffect, useState } from "react";
import { toast } from "sonner";
import { apiPatch, apiPost, ApiError } from "@/lib/api";
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
import { Textarea } from "@/components/ui/textarea";
import { Spinner } from "@/components/ui/misc";
import type { ImportSourceRow } from "./types";

// Create (source == null) or rename/describe (source != null) an import source.
export function SourceFormDialog({
  projectId,
  source,
  open,
  onOpenChange,
  onSaved,
}: {
  projectId: string;
  source: ImportSourceRow | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSaved: () => void;
}) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [busy, setBusy] = useState(false);

  // Re-seed the form each time the dialog opens (create vs edit).
  useEffect(() => {
    if (open) {
      setName(source?.name ?? "");
      setDescription(source?.description ?? "");
    }
  }, [open, source]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      if (source) {
        await apiPatch(`/api/projects/${projectId}/import-sources/${source.id}`, {
          name: name.trim(),
          description: description.trim() === "" ? null : description.trim(),
        });
        toast.success("Source updated");
      } else {
        await apiPost(`/api/projects/${projectId}/import-sources`, {
          name: name.trim(),
          ...(description.trim() !== "" ? { description: description.trim() } : {}),
        });
        toast.success("Source created");
      }
      onOpenChange(false);
      onSaved();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Failed to save source");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{source ? "Edit source" : "New import source"}</DialogTitle>
          <DialogDescription>
            Sources record where citations came from (e.g. PubMed, Embase, hand search) for the
            PRISMA flow.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="src-name">Name</Label>
            <Input
              id="src-name"
              required
              maxLength={120}
              placeholder="PubMed"
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="src-desc">Description (optional)</Label>
            <Textarea
              id="src-desc"
              maxLength={2000}
              placeholder="Search strategy, date range, notes…"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
            />
          </div>
          <DialogFooter>
            <Button type="submit" disabled={busy || name.trim() === ""}>
              {busy && <Spinner />} {source ? "Save changes" : "Create source"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
