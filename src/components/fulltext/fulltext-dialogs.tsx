"use client";

import { useEffect, useState } from "react";
import { toast } from "sonner";
import { api, apiPost, ApiError } from "@/lib/api";
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
import { Select } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { Alert, Spinner } from "@/components/ui/misc";
import type {
  DecisionResponse,
  ExclusionReason,
  RetrievalOutcome,
  UploadResult,
} from "@/components/fulltext/types";

const MAX_PDF_BYTES = 50 * 1024 * 1024; // mirrors the server's 50 MB cap for a friendlier early error

// ---------------------------------------------------------------------------
// Upload PDF
// ---------------------------------------------------------------------------

export function UploadPdfDialog({
  projectId,
  citationId,
  open,
  onOpenChange,
  onUploaded,
}: {
  projectId: string;
  citationId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onUploaded: () => void;
}) {
  const [file, setFile] = useState<File | null>(null);
  const [label, setLabel] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (open) {
      setFile(null);
      setLabel("");
    }
  }, [open]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!file) return;
    if (file.size > MAX_PDF_BYTES) {
      toast.error("File exceeds the 50 MB upload limit");
      return;
    }
    setBusy(true);
    try {
      const fd = new FormData();
      fd.append("file", file);
      fd.append("citationId", citationId);
      if (label.trim()) fd.append("label", label.trim());
      const res = await api<UploadResult>(`/api/projects/${projectId}/fulltext/files`, {
        method: "POST",
        body: fd,
      });
      if (res.reused && !res.linkCreated) {
        toast.success("This PDF was already linked to the citation");
      } else if (res.reused) {
        toast.success("Existing project PDF linked to the citation");
      } else {
        toast.success("PDF uploaded and linked");
      }
      onOpenChange(false);
      onUploaded();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Upload failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Upload full-text PDF</DialogTitle>
          <DialogDescription>
            PDF only, up to 50 MB. The file is linked to this citation and marks it retrieved.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor={`ft-file-${citationId}`}>PDF file</Label>
            <Input
              id={`ft-file-${citationId}`}
              type="file"
              accept="application/pdf,.pdf"
              required
              onChange={(e) => setFile(e.target.files?.[0] ?? null)}
              className="h-auto py-1.5"
            />
            {file && (
              <p className="text-xs text-muted-foreground">
                {file.name} · {(file.size / (1024 * 1024)).toFixed(1)} MB
              </p>
            )}
          </div>
          <div className="space-y-1.5">
            <Label htmlFor={`ft-label-${citationId}`}>Label (optional)</Label>
            <Input
              id={`ft-label-${citationId}`}
              placeholder='e.g. "main paper", "supplement"'
              value={label}
              maxLength={200}
              onChange={(e) => setLabel(e.target.value)}
            />
          </div>
          <DialogFooter>
            <Button type="submit" disabled={busy || !file}>
              {busy && <Spinner />} Upload
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Record retrieval attempt
// ---------------------------------------------------------------------------

const OUTCOME_OPTIONS: { value: RetrievalOutcome; label: string }[] = [
  { value: "RETRIEVED", label: "Retrieved" },
  { value: "NOT_RETRIEVED", label: "Not retrieved" },
  { value: "PENDING", label: "Pending (e.g. requested)" },
];

export function RetrievalAttemptDialog({
  projectId,
  citationId,
  open,
  defaultOutcome,
  onOpenChange,
  onSaved,
}: {
  projectId: string;
  citationId: string;
  open: boolean;
  defaultOutcome: RetrievalOutcome;
  onOpenChange: (open: boolean) => void;
  onSaved: () => void;
}) {
  const [outcome, setOutcome] = useState<RetrievalOutcome>(defaultOutcome);
  const [method, setMethod] = useState("");
  const [notes, setNotes] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (open) {
      setOutcome(defaultOutcome);
      setMethod("");
      setNotes("");
    }
  }, [open, defaultOutcome]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      await apiPost(`/api/projects/${projectId}/citations/${citationId}/retrieval-attempts`, {
        method: method.trim(),
        outcome,
        notes: notes.trim() || undefined,
      });
      toast.success("Retrieval attempt recorded");
      onOpenChange(false);
      onSaved();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Failed to record attempt");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Record retrieval attempt</DialogTitle>
          <DialogDescription>
            Citations marked not retrieved feed the PRISMA &ldquo;reports not retrieved&rdquo;
            count.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor={`ra-outcome-${citationId}`}>Outcome</Label>
            <Select
              id={`ra-outcome-${citationId}`}
              value={outcome}
              onChange={(e) => setOutcome(e.target.value as RetrievalOutcome)}
            >
              {OUTCOME_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor={`ra-method-${citationId}`}>Method</Label>
            <Input
              id={`ra-method-${citationId}`}
              required
              minLength={2}
              maxLength={200}
              placeholder="e.g. publisher site, library, ILL, author email"
              value={method}
              onChange={(e) => setMethod(e.target.value)}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor={`ra-notes-${citationId}`}>Notes (optional)</Label>
            <Textarea
              id={`ra-notes-${citationId}`}
              maxLength={2000}
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
            />
          </div>
          <DialogFooter>
            <Button type="submit" disabled={busy || method.trim().length < 2}>
              {busy && <Spinner />} Record attempt
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Full-text exclude decision (reason required)
// ---------------------------------------------------------------------------

export function ExcludeDialog({
  projectId,
  stageId,
  citationId,
  reasons,
  open,
  onOpenChange,
  onDecided,
}: {
  projectId: string;
  stageId: string;
  citationId: string;
  reasons: ExclusionReason[] | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onDecided: () => void;
}) {
  const [reasonId, setReasonId] = useState("");
  const [notes, setNotes] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (open) {
      setReasonId("");
      setNotes("");
    }
  }, [open]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!reasonId) return;
    setBusy(true);
    try {
      const res = await apiPost<DecisionResponse>(
        `/api/projects/${projectId}/screening/stages/${stageId}/decisions`,
        {
          citationId,
          decision: "EXCLUDE",
          exclusionReasonId: reasonId,
          notes: notes.trim() || undefined,
        },
      );
      toast.success(
        res.result
          ? `Decision saved — citation settled as ${res.result.outcome.toLowerCase()}`
          : "Exclude decision saved",
      );
      onOpenChange(false);
      onDecided();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Failed to save decision");
    } finally {
      setBusy(false);
    }
  }

  const noReasons = reasons !== null && reasons.length === 0;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Exclude at full text</DialogTitle>
          <DialogDescription>
            Full-text exclusions require a reason — it appears in the PRISMA flow diagram.
          </DialogDescription>
        </DialogHeader>
        {noReasons ? (
          <Alert variant="warning">
            No full-text exclusion reasons are defined for this project. A protocol editor must
            add them before citations can be excluded at this stage.
          </Alert>
        ) : (
          <form onSubmit={submit} className="space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor={`ex-reason-${citationId}`}>Exclusion reason</Label>
              <Select
                id={`ex-reason-${citationId}`}
                required
                value={reasonId}
                onChange={(e) => setReasonId(e.target.value)}
                disabled={reasons === null}
              >
                <option value="">
                  {reasons === null ? "Loading reasons…" : "Select a reason…"}
                </option>
                {(reasons ?? []).map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.label}
                  </option>
                ))}
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor={`ex-notes-${citationId}`}>Note (optional)</Label>
              <Textarea
                id={`ex-notes-${citationId}`}
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
              />
            </div>
            <DialogFooter>
              <Button type="submit" variant="exclude" disabled={busy || !reasonId}>
                {busy && <Spinner />} Exclude citation
              </Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}
