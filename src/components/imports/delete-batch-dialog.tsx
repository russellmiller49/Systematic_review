"use client";

import { useEffect, useState } from "react";
import { ShieldAlert, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { api, apiDelete, apiPost, ApiError } from "@/lib/api";
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
import { Textarea } from "@/components/ui/textarea";
import type {
  DeleteBatchResult,
  ImportBatchRow,
  OwnerRollbackPreview,
} from "./types";

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
  const [isOwner, setIsOwner] = useState(false);
  const [deleteScreeningHistory, setDeleteScreeningHistory] = useState(false);
  const [confirmation, setConfirmation] = useState("");
  const [reason, setReason] = useState("");
  const [preview, setPreview] = useState<OwnerRollbackPreview | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setIsOwner(false);
    api<{ myRoles: string[] }>(`/api/projects/${projectId}`)
      .then((project) => {
        if (!cancelled) setIsOwner(project.myRoles.includes("OWNER"));
      })
      .catch(() => {
        if (!cancelled) setIsOwner(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open, projectId]);

  useEffect(() => {
    if (open) return;
    setDeleteScreeningHistory(false);
    setConfirmation("");
    setReason("");
    setPreview(null);
    setPreviewError(null);
  }, [open, batch?.id]);

  useEffect(() => {
    if (!open || !batch || !isOwner || !deleteScreeningHistory) {
      setPreview(null);
      setPreviewError(null);
      setPreviewLoading(false);
      return;
    }
    let cancelled = false;
    setPreviewLoading(true);
    setPreviewError(null);
    api<OwnerRollbackPreview>(
      `/api/projects/${projectId}/imports/${batch.id}/owner-rollback`,
    )
      .then((result) => {
        if (!cancelled) setPreview(result);
      })
      .catch((err) => {
        if (!cancelled) {
          setPreviewError(err instanceof ApiError ? err.message : "Failed to inspect this import");
        }
      })
      .finally(() => {
        if (!cancelled) setPreviewLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [batch, deleteScreeningHistory, isOwner, open, projectId]);

  async function remove() {
    if (!batch) return;
    setBusy(true);
    try {
      const result = deleteScreeningHistory
        ? await apiPost<DeleteBatchResult>(
            `/api/projects/${projectId}/imports/${batch.id}/owner-rollback`,
            { confirmation, reason },
          )
        : await apiDelete<DeleteBatchResult>(
            `/api/projects/${projectId}/imports/${batch.id}`,
          );
      const deleted = result.citationsDeleted;
      const screeningDeleted = Object.values(result.screeningHistoryDeleted).reduce(
        (total, count) => total + count,
        0,
      );
      const descriptions: string[] = [];
      if (screeningDeleted > 0) {
        descriptions.push(
          `${screeningDeleted.toLocaleString()} screening record${screeningDeleted === 1 ? " was" : "s were"} permanently deleted.`,
        );
      }
      if (result.citationsRetained > 0) {
        descriptions.push(
          `${result.citationsRetained.toLocaleString()} citation${result.citationsRetained === 1 ? " was" : "s were"} retained because they are also linked to another import.`,
        );
      }
      if (result.deduplicationHistoryDeleted.candidates > 0) {
        descriptions.push(
          `${result.deduplicationHistoryDeleted.candidates.toLocaleString()} duplicate-pair record${result.deduplicationHistoryDeleted.candidates === 1 ? " was" : "s were"} removed.`,
        );
      }
      if (result.deduplicationHistoryDeleted.retainedCitationsRestored > 0) {
        descriptions.push(
          `${result.deduplicationHistoryDeleted.retainedCitationsRestored.toLocaleString()} citation${result.deduplicationHistoryDeleted.retainedCitationsRestored === 1 ? " from another import was" : "s from other imports were"} restored.`,
        );
      }
      toast.success(
        deleted > 0
          ? `Import deleted — ${deleted.toLocaleString()} citation${deleted === 1 ? "" : "s"} removed`
          : "Import deleted",
        descriptions.length > 0 ? { description: descriptions.join(" ") } : undefined,
      );
      onOpenChange(false);
      onDeleted(result);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Failed to delete import");
    } finally {
      setBusy(false);
    }
  }

  const ownerConfirmationValid =
    !deleteScreeningHistory ||
    (batch !== null && confirmation === batch.filename && reason.trim().length >= 3);
  const previewAllowsDelete =
    !deleteScreeningHistory || (preview !== null && preview.canDelete && !previewLoading);
  const previewScreeningRecords = preview
    ? Object.values(preview.screeningHistory).reduce((total, count) => total + count, 0)
    : 0;

  return (
    <Dialog open={open} onOpenChange={(next) => !busy && onOpenChange(next)}>
      <DialogContent className="max-h-[85vh] overflow-y-auto">
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
        {batch?.status === "COMMITTED" && isOwner && (
          <div className="space-y-3 rounded-md border border-border p-3">
            <label className="flex items-start gap-2 text-sm">
              <input
                type="checkbox"
                className="mt-0.5 h-4 w-4 accent-[var(--color-primary)]"
                checked={deleteScreeningHistory}
                onChange={(event) => setDeleteScreeningHistory(event.target.checked)}
              />
              <span>
                Owner override: also delete screening history
                <span className="mt-0.5 block text-xs text-muted-foreground">
                  Use this when an accidental import has already been assigned or screened.
                </span>
              </span>
            </label>
            {deleteScreeningHistory && (
              <div className="space-y-3">
                <Alert variant="error">
                  <span className="flex items-start gap-2">
                    <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0" />
                    <span>
                      This permanently deletes assignments, decisions, conflicts and
                      adjudications, final screening results, and AI screening suggestions for
                      citations created only by this import. Citations shared by another import
                      keep all history. Linked studies, full text, extraction, reference-library,
                      retrieval, or cohort work will still block deletion.
                    </span>
                  </span>
                </Alert>
                {previewLoading && (
                  <Alert>
                    <span className="flex items-center gap-2">
                      <Spinner /> Checking screening, deduplication, and downstream work…
                    </span>
                  </Alert>
                )}
                {previewError && <Alert variant="error">{previewError}</Alert>}
                {preview && preview.blockers.length > 0 && (
                  <Alert variant="error">
                    <p className="font-medium">Deletion is blocked by:</p>
                    <ul className="mt-2 list-disc space-y-1 pl-5">
                      {preview.blockers.map((blocker) => (
                        <li key={blocker.kind}>
                          {blocker.count.toLocaleString()} citation
                          {blocker.count === 1 ? "" : "s"} with {blocker.label}
                          {blocker.citations.length > 0
                            ? ` — ${blocker.citations.map((citation) => citation.title).join("; ")}`
                            : ""}
                        </li>
                      ))}
                    </ul>
                  </Alert>
                )}
                {preview && preview.blockers.length === 0 && (
                  <Alert variant="success">
                    <p className="font-medium">This rollback can proceed.</p>
                    <p className="mt-1">
                      It will delete {preview.citationsToDelete.toLocaleString()} citation
                      {preview.citationsToDelete === 1 ? "" : "s"} created only by this import.
                    </p>
                    <ul className="mt-2 list-disc space-y-1 pl-5">
                      <li>
                        Screening: {preview.screeningHistory.assignments.toLocaleString()} assignments,
                        {" "}{preview.screeningHistory.decisions.toLocaleString()} decisions, and{" "}
                        {preview.screeningHistory.stageResults.toLocaleString()} final results
                        ({previewScreeningRecords.toLocaleString()} total records).
                      </li>
                      <li>
                        Deduplication: {preview.deduplication.citationsWithRelationships.toLocaleString()} imported citations
                        {" "}across {preview.deduplication.candidates.toLocaleString()} pair records
                        and {preview.deduplication.groups.toLocaleString()} groups.
                      </li>
                      {preview.deduplication.retainedCitationsToRestore > 0 && (
                        <li>
                          {preview.deduplication.retainedCitationsToRestore.toLocaleString()} citation
                          {preview.deduplication.retainedCitationsToRestore === 1
                            ? " from another import will"
                            : "s from other imports will"} be restored as active.
                        </li>
                      )}
                    </ul>
                  </Alert>
                )}
                <div className="space-y-1.5">
                  <Label htmlFor="delete-import-reason">Reason for owner override</Label>
                  <Textarea
                    id="delete-import-reason"
                    value={reason}
                    onChange={(event) => setReason(event.target.value)}
                    placeholder="Accidental or incorrect import"
                    maxLength={2000}
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="delete-import-confirmation">
                    Type <span className="font-mono">{batch.filename}</span> to confirm
                  </Label>
                  <Input
                    id="delete-import-confirmation"
                    value={confirmation}
                    onChange={(event) => setConfirmation(event.target.value)}
                    autoComplete="off"
                  />
                </div>
              </div>
            )}
          </div>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>
            Cancel
          </Button>
          <Button
            variant="destructive"
            onClick={remove}
            disabled={busy || !batch || !ownerConfirmationValid || !previewAllowsDelete}
          >
            {busy ? <Spinner /> : <Trash2 />} {deleteScreeningHistory
              ? "Delete import and screening history"
              : "Delete import"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
