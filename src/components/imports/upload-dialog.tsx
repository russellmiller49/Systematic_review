"use client";

import { useEffect, useState } from "react";
import { toast } from "sonner";
import { api, ApiError } from "@/lib/api";
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
import { Alert, Spinner } from "@/components/ui/misc";
import type { ImportBatchRow, ImportSourceRow } from "./types";
import { FORMAT_LABELS } from "./types";

const MAX_IMPORT_BYTES = 20 * 1024 * 1024; // mirrors the server-side 20 MB limit

function formatSize(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${bytes} B`;
}

// Upload a citation file: multipart FormData with file + sourceId (+ optional format).
// The server parses immediately and returns a PREVIEWED batch.
export function UploadDialog({
  projectId,
  sources,
  open,
  onOpenChange,
  onUploaded,
}: {
  projectId: string;
  sources: ImportSourceRow[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onUploaded: (batchId: string) => void;
}) {
  const [sourceId, setSourceId] = useState("");
  const [format, setFormat] = useState(""); // "" = auto-detect
  const [file, setFile] = useState<File | null>(null);
  const [fileInputKey, setFileInputKey] = useState(0); // reset the uncontrolled file input
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (open) {
      setSourceId((prev) => (sources.some((s) => s.id === prev) ? prev : (sources[0]?.id ?? "")));
      setFormat("");
      setFile(null);
      setFileInputKey((k) => k + 1);
    }
  }, [open, sources]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!file || !sourceId) return;
    if (file.size > MAX_IMPORT_BYTES) {
      toast.error("Import file exceeds the 20 MB limit");
      return;
    }
    setBusy(true);
    try {
      const fd = new FormData();
      fd.append("file", file);
      fd.append("sourceId", sourceId);
      if (format !== "") fd.append("format", format);
      const batch = await api<ImportBatchRow>(`/api/projects/${projectId}/imports`, {
        method: "POST",
        body: fd,
      });
      toast.success(
        `Parsed ${batch.parsedRecords.toLocaleString()} of ${batch.totalRecords.toLocaleString()} records`,
        {
          description:
            batch.failedRecords > 0
              ? `${batch.failedRecords.toLocaleString()} rows could not be parsed — review them before committing.`
              : "Review the preview, then commit to create citations.",
        },
      );
      onOpenChange(false);
      onUploaded(batch.id);
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
          <DialogTitle>Import citations</DialogTitle>
          <DialogDescription>
            Upload a database export. Records are parsed into a preview first — nothing is created
            until you commit the batch.
          </DialogDescription>
        </DialogHeader>
        {sources.length === 0 ? (
          <Alert variant="warning">
            Create an import source first so this batch can be attributed to a database or search.
          </Alert>
        ) : (
          <form onSubmit={submit} className="space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="imp-source">Source</Label>
              <Select
                id="imp-source"
                required
                value={sourceId}
                onChange={(e) => setSourceId(e.target.value)}
              >
                {sources.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="imp-format">Format</Label>
              <Select id="imp-format" value={format} onChange={(e) => setFormat(e.target.value)}>
                <option value="">Auto-detect</option>
                {(Object.keys(FORMAT_LABELS) as (keyof typeof FORMAT_LABELS)[]).map((f) => (
                  <option key={f} value={f}>
                    {FORMAT_LABELS[f]}
                  </option>
                ))}
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="imp-file">File</Label>
              <Input
                key={fileInputKey}
                id="imp-file"
                type="file"
                required
                accept=".ris,.txt,.bib,.bibtex,.csv,.nbib"
                onChange={(e) => setFile(e.target.files?.[0] ?? null)}
              />
              <p className="text-xs text-muted-foreground">
                {file
                  ? `${file.name} · ${formatSize(file.size)}`
                  : "RIS, BibTeX, CSV, or PubMed NBIB — up to 20 MB."}
              </p>
            </div>
            <DialogFooter>
              <Button type="submit" disabled={busy || !file || !sourceId}>
                {busy && <Spinner />} Upload &amp; preview
              </Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}
