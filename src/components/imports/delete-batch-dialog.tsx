"use client";

import { useState } from "react";
import { Trash2 } from "lucide-react";
import { toast } from "sonner";
import { apiDelete, ApiError } from "@/lib/api";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Spinner } from "@/components/ui/misc";
import type { DeleteBatchResult, ImportBatchRow } from "./types";

export function DeleteBatchDialog({
  projectId,
  batch,
  open,
  onOpenChange,
  onDeleted,
}: {
  projectId: string;
  batch: ImportBatchRow | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onDeleted: (result: DeleteBatchResult) => void;
}) {
  const [busy, setBusy] = useState(false);

  async function remove() {
    if (!batch) return;
    setBusy(true);
    try {
      const result = await apiDelete<DeleteBatchResult>(
        `/api/projects/${projectId}/imports/${batch.id}`,
      );
      const deleted = result.citationsDeleted;
      toast.success(
        deleted > 0
          ? `Import deleted — ${deleted.toLocaleString()} citation${deleted === 1 ? "" : "s"} removed`
          : "Import deleted",
        result.citationsRetained > 0
          ? {
              description: `${result.citationsRetained.toLocaleString()} citation${result.citationsRetained === 1 ? " was" : "s were"} retained because they are also linked to another import.`,
            }
          : undefined,
      );
      onOpenChange(false);
      onDeleted(result);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Failed to delete import");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={(next) => !busy && onOpenChange(next)}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Delete import{batch ? ` “${batch.filename}”` : ""}?</DialogTitle>
          <DialogDescription>
            {batch?.status === "COMMITTED"
              ? "This removes the import and citations created only by it. The deletion will be blocked if any citation has downstream review or AI work. This cannot be undone."
              : "This removes the import preview and its parsed source records. No citations have been created from this batch."}
          </DialogDescription>
        </DialogHeader>
        {batch && (
          <p className="rounded-md border border-border bg-muted/40 p-3 text-sm">
            {batch.totalRecords.toLocaleString()} total records · {batch.parsedRecords.toLocaleString()} parsed
            {batch.failedRecords > 0
              ? ` · ${batch.failedRecords.toLocaleString()} failed`
              : ""}
          </p>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>
            Cancel
          </Button>
          <Button variant="destructive" onClick={remove} disabled={busy || !batch}>
            {busy ? <Spinner /> : <Trash2 />} Delete import
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
