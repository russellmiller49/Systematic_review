"use client";

import { useCallback, useEffect, useState } from "react";
import { Download, FileDown, FilePlus2 } from "lucide-react";
import { toast } from "sonner";
import { api, apiPost, ApiError } from "@/lib/api";
import { formatDateTime } from "@/lib/utils";
import { Badge, type BadgeProps } from "@/components/ui/badge";
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
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import { EmptyState, Skeleton, Spinner } from "@/components/ui/misc";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

interface ExportJobRow {
  id: string;
  kind: string;
  format: string;
  status: string;
  error?: string | null;
  createdAt: string;
  requestedBy: { id: string; name: string };
}

// Kinds beyond CITATIONS/PRISMA can contain blinded work products and are admin-gated
// server-side (R1) — creating or downloading them may 403; we surface the API message.
const EXPORT_KINDS: { value: string; label: string }[] = [
  { value: "CITATIONS", label: "Citations" },
  { value: "PRISMA", label: "PRISMA counts" },
  { value: "ANALYSIS", label: "Analysis results" },
  { value: "SCREENING", label: "Screening (admin only)" },
  { value: "EXTRACTION", label: "Extraction (admin only)" },
  { value: "ROB", label: "Risk of bias (admin only)" },
  { value: "AUDIT", label: "Audit trail (admin only)" },
  { value: "FULL", label: "Full project (admin only, JSON)" },
];

function kindLabel(kind: string): string {
  return EXPORT_KINDS.find((k) => k.value === kind)?.label.replace(/ \(.*\)$/, "") ?? kind;
}

function statusVariant(status: string): BadgeProps["variant"] {
  if (status === "COMPLETED") return "include";
  if (status === "FAILED") return "exclude";
  return "maybe";
}

export function ExportsSection({ projectId }: { projectId: string }) {
  const [jobs, setJobs] = useState<ExportJobRow[] | null>(null);
  const [hidden, setHidden] = useState(false);

  const [createOpen, setCreateOpen] = useState(false);
  const [kind, setKind] = useState("CITATIONS");
  const [format, setFormat] = useState("CSV");
  const [creating, setCreating] = useState(false);
  const [downloadingId, setDownloadingId] = useState<string | null>(null);

  const load = useCallback(() => {
    api<ExportJobRow[]>(`/api/projects/${projectId}/exports`)
      .then(setJobs)
      .catch((err) => {
        if (err instanceof ApiError && err.status === 403) {
          setHidden(true); // viewer lacks export.create — nothing useful to show
        } else {
          toast.error("Failed to load exports");
          setJobs([]);
        }
      });
  }, [projectId]);

  useEffect(load, [load]);

  async function createExport(e: React.FormEvent) {
    e.preventDefault();
    setCreating(true);
    try {
      await apiPost(`/api/projects/${projectId}/exports`, { kind, format });
      toast.success("Export created");
      setCreateOpen(false);
      load();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Failed to create export");
    } finally {
      setCreating(false);
    }
  }

  // Fetch instead of a bare <a href> so permission errors surface as toasts, not raw JSON.
  async function downloadJob(job: ExportJobRow) {
    setDownloadingId(job.id);
    try {
      const res = await fetch(`/api/projects/${projectId}/exports/${job.id}/download`);
      if (!res.ok) {
        let message = `Download failed (${res.status})`;
        try {
          const body = (await res.json()) as { error?: { message?: string } };
          if (body.error?.message) message = body.error.message;
        } catch {
          // non-JSON error body — keep the fallback message
        }
        toast.error(message);
        return;
      }
      const blob = await res.blob();
      const disposition = res.headers.get("Content-Disposition") ?? "";
      const match = /filename="([^"]+)"/.exec(disposition);
      const filename =
        match?.[1] ?? `${job.kind.toLowerCase()}.${job.format === "CSV" ? "csv" : "json"}`;
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = filename;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      URL.revokeObjectURL(url);
    } catch {
      toast.error("Download failed");
    } finally {
      setDownloadingId(null);
    }
  }

  if (hidden) return null;

  return (
    <section className="space-y-3">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-lg font-medium">Exports</h2>
          <p className="text-sm text-muted-foreground">
            Download project data as CSV or JSON. Kinds containing blinded work products
            require admin rights.
          </p>
        </div>
        <Dialog open={createOpen} onOpenChange={setCreateOpen}>
          <DialogTrigger asChild>
            <Button variant="outline" size="sm">
              <FilePlus2 /> New export
            </Button>
          </DialogTrigger>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Create export</DialogTitle>
              <DialogDescription>
                Screening, extraction, risk-of-bias, audit, and full exports include blinded
                work products and require admin rights.
              </DialogDescription>
            </DialogHeader>
            <form onSubmit={createExport} className="space-y-4">
              <div className="space-y-1.5">
                <Label htmlFor="ex-kind">Kind</Label>
                <Select
                  id="ex-kind"
                  value={kind}
                  onChange={(e) => {
                    setKind(e.target.value);
                    if (e.target.value === "FULL") setFormat("JSON");
                  }}
                >
                  {EXPORT_KINDS.map((k) => (
                    <option key={k.value} value={k.value}>
                      {k.label}
                    </option>
                  ))}
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="ex-format">Format</Label>
                <Select
                  id="ex-format"
                  value={format}
                  onChange={(e) => setFormat(e.target.value)}
                >
                  <option value="CSV" disabled={kind === "FULL"}>
                    CSV
                  </option>
                  <option value="JSON">JSON</option>
                </Select>
              </div>
              <DialogFooter>
                <Button type="submit" disabled={creating}>
                  {creating && <Spinner />} Create export
                </Button>
              </DialogFooter>
            </form>
          </DialogContent>
        </Dialog>
      </div>

      {jobs === null ? (
        <Skeleton className="h-32" />
      ) : jobs.length === 0 ? (
        <EmptyState
          icon={FileDown}
          title="No exports yet"
          description="Create an export to download citations, screening data, or a PRISMA summary."
        />
      ) : (
        <div className="rounded-lg border border-border bg-card">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Kind</TableHead>
                <TableHead>Format</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Requested by</TableHead>
                <TableHead>Requested at</TableHead>
                <TableHead className="w-32" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {jobs.map((job) => (
                <TableRow key={job.id}>
                  <TableCell className="font-medium">{kindLabel(job.kind)}</TableCell>
                  <TableCell className="text-muted-foreground">{job.format}</TableCell>
                  <TableCell>
                    <Badge variant={statusVariant(job.status)} title={job.error ?? undefined}>
                      {job.status.toLowerCase()}
                    </Badge>
                  </TableCell>
                  <TableCell className="text-muted-foreground">
                    {job.requestedBy.name}
                  </TableCell>
                  <TableCell className="text-muted-foreground">
                    {formatDateTime(job.createdAt)}
                  </TableCell>
                  <TableCell>
                    {job.status === "COMPLETED" && (
                      <div className="flex justify-end">
                        <Button
                          variant="outline"
                          size="sm"
                          disabled={downloadingId === job.id}
                          onClick={() => downloadJob(job)}
                        >
                          {downloadingId === job.id ? <Spinner /> : <Download />} Download
                        </Button>
                      </div>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </section>
  );
}
