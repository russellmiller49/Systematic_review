"use client";

import { useCallback, useEffect, useState } from "react";
import { Database, FileUp, Pencil, Plus, Trash2, Upload } from "lucide-react";
import { toast } from "sonner";
import { api, apiDelete, ApiError } from "@/lib/api";
import { PageHeader } from "@/components/layout/page-header";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { EmptyState, Skeleton } from "@/components/ui/misc";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { BatchDetail } from "./batch-detail";
import { SourceFormDialog } from "./source-form-dialog";
import { UploadDialog } from "./upload-dialog";
import type { ImportBatchRow, ImportSourceRow } from "./types";
import { BATCH_STATUS_VARIANT, FORMAT_LABELS } from "./types";

export function ImportClient({ projectId }: { projectId: string }) {
  const [sources, setSources] = useState<ImportSourceRow[] | null>(null);
  const [batches, setBatches] = useState<ImportBatchRow[] | null>(null);
  const [selectedBatchId, setSelectedBatchId] = useState<string | null>(null);

  const [uploadOpen, setUploadOpen] = useState(false);
  const [sourceDialogOpen, setSourceDialogOpen] = useState(false);
  const [editingSource, setEditingSource] = useState<ImportSourceRow | null>(null);
  const [deletingSourceId, setDeletingSourceId] = useState<string | null>(null);

  const load = useCallback(() => {
    api<ImportSourceRow[]>(`/api/projects/${projectId}/import-sources`)
      .then(setSources)
      .catch(() => {
        setSources([]);
        toast.error("Failed to load import sources");
      });
    api<ImportBatchRow[]>(`/api/projects/${projectId}/imports`)
      .then(setBatches)
      .catch(() => {
        setBatches([]);
        toast.error("Failed to load import batches");
      });
  }, [projectId]);

  useEffect(load, [load]);

  async function deleteSource(source: ImportSourceRow) {
    setDeletingSourceId(source.id);
    try {
      await apiDelete(`/api/projects/${projectId}/import-sources/${source.id}`);
      toast.success(`Source "${source.name}" deleted`);
      load();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Failed to delete source");
    } finally {
      setDeletingSourceId(null);
    }
  }

  if (selectedBatchId !== null) {
    return (
      <BatchDetail
        projectId={projectId}
        batchId={selectedBatchId}
        onBack={() => setSelectedBatchId(null)}
        onChanged={load}
      />
    );
  }

  return (
    <div className="space-y-8">
      <PageHeader
        title="Import"
        description="Bring citations into the project from database exports, then commit each batch."
        actions={
          <Button onClick={() => setUploadOpen(true)}>
            <Upload /> New import
          </Button>
        }
      />

      <section className="space-y-3">
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-medium">Sources</h2>
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              setEditingSource(null);
              setSourceDialogOpen(true);
            }}
          >
            <Plus /> Add source
          </Button>
        </div>
        {sources === null ? (
          <Skeleton className="h-32" />
        ) : sources.length === 0 ? (
          <EmptyState
            icon={Database}
            title="No import sources"
            description="Add a source for each database or search (e.g. PubMed, Embase) so batches are attributed correctly in the PRISMA flow."
            action={
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  setEditingSource(null);
                  setSourceDialogOpen(true);
                }}
              >
                <Plus /> Add source
              </Button>
            }
          />
        ) : (
          <div className="rounded-lg border border-border bg-card">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Name</TableHead>
                  <TableHead>Description</TableHead>
                  <TableHead className="w-20">Batches</TableHead>
                  <TableHead className="w-28">Created</TableHead>
                  <TableHead className="w-24 text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {sources.map((s) => {
                  const batchCount = s._count?.batches ?? 0;
                  return (
                    <TableRow key={s.id}>
                      <TableCell className="font-medium">{s.name}</TableCell>
                      <TableCell className="max-w-72 truncate text-muted-foreground">
                        {s.description ?? "—"}
                      </TableCell>
                      <TableCell className="tabular-nums">{batchCount}</TableCell>
                      <TableCell className="text-muted-foreground">
                        {new Date(s.createdAt).toLocaleDateString()}
                      </TableCell>
                      <TableCell>
                        <div className="flex justify-end gap-1">
                          <Button
                            variant="ghost"
                            size="icon"
                            aria-label={`Edit source ${s.name}`}
                            onClick={() => {
                              setEditingSource(s);
                              setSourceDialogOpen(true);
                            }}
                          >
                            <Pencil />
                          </Button>
                          <Button
                            variant="ghost"
                            size="icon"
                            aria-label={`Delete source ${s.name}`}
                            disabled={batchCount > 0 || deletingSourceId === s.id}
                            title={
                              batchCount > 0
                                ? "Sources with import batches cannot be deleted"
                                : undefined
                            }
                            onClick={() => deleteSource(s)}
                          >
                            <Trash2 />
                          </Button>
                        </div>
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </div>
        )}
      </section>

      <section className="space-y-3">
        <h2 className="text-lg font-medium">Import batches</h2>
        {batches === null ? (
          <Skeleton className="h-40" />
        ) : batches.length === 0 ? (
          <EmptyState
            icon={FileUp}
            title="No imports yet"
            description="Upload a RIS, BibTeX, CSV, or PubMed NBIB export to preview and commit citations."
            action={
              <Button size="sm" onClick={() => setUploadOpen(true)}>
                <Upload /> New import
              </Button>
            }
          />
        ) : (
          <div className="rounded-lg border border-border bg-card">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>File</TableHead>
                  <TableHead>Source</TableHead>
                  <TableHead className="w-24">Format</TableHead>
                  <TableHead className="w-28">Status</TableHead>
                  <TableHead>Records</TableHead>
                  <TableHead>Uploaded by</TableHead>
                  <TableHead className="w-28">Created</TableHead>
                  <TableHead className="w-20 text-right">View</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {batches.map((b) => (
                  <TableRow key={b.id}>
                    <TableCell className="max-w-56 truncate font-medium" title={b.filename}>
                      {b.filename}
                    </TableCell>
                    <TableCell className="text-muted-foreground">{b.source.name}</TableCell>
                    <TableCell>
                      <Badge variant="outline">{FORMAT_LABELS[b.format]}</Badge>
                    </TableCell>
                    <TableCell>
                      <Badge variant={BATCH_STATUS_VARIANT[b.status]}>
                        {b.status.toLowerCase()}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      <span className="tabular-nums">
                        {b.parsedRecords.toLocaleString()}/{b.totalRecords.toLocaleString()}
                      </span>{" "}
                      parsed
                      {b.failedRecords > 0 && (
                        <span className="text-exclude"> · {b.failedRecords} failed</span>
                      )}
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      {b.createdBy?.name ?? "—"}
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      {new Date(b.createdAt).toLocaleDateString()}
                    </TableCell>
                    <TableCell className="text-right">
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => setSelectedBatchId(b.id)}
                      >
                        {b.status === "PREVIEWED" ? "Preview" : "View"}
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </section>

      <UploadDialog
        projectId={projectId}
        sources={sources ?? []}
        open={uploadOpen}
        onOpenChange={setUploadOpen}
        onUploaded={(batchId) => {
          setSelectedBatchId(batchId);
          load();
        }}
      />
      <SourceFormDialog
        projectId={projectId}
        source={editingSource}
        open={sourceDialogOpen}
        onOpenChange={setSourceDialogOpen}
        onSaved={load}
      />
    </div>
  );
}
