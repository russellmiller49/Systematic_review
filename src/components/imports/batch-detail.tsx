"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { ArrowLeft, CheckCircle2, FileWarning, Inbox, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { api, apiPost, ApiError } from "@/lib/api";
import { formatAuthors } from "@/components/citations/citation-card";
import { StatCard } from "@/components/layout/page-header";
import { Badge } from "@/components/ui/badge";
import { Button, buttonVariants } from "@/components/ui/button";
import { Alert, EmptyState, Skeleton, Spinner } from "@/components/ui/misc";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import type { CommitResult, ImportBatchDetail, SourceRecordRow } from "./types";
import { BATCH_STATUS_VARIANT, FORMAT_LABELS } from "./types";
import { DeleteBatchDialog } from "./delete-batch-dialog";

const PREVIEW_ROW_CAP = 200;
const ERROR_ROW_CAP = 50;

// Rows whose DOI or PMID appears more than once in this batch — a client-side hint
// computed purely from the returned preview rows (exact matches only).
function duplicateKeysInBatch(rows: SourceRecordRow[]): Set<string> {
  const counts = new Map<string, number>();
  const keysOf = (row: SourceRecordRow): string[] => {
    const keys: string[] = [];
    const doi = row.parsed?.doi?.trim().toLowerCase();
    const pmid = row.parsed?.pmid?.trim();
    if (doi) keys.push(`doi:${doi}`);
    if (pmid) keys.push(`pmid:${pmid}`);
    return keys;
  };
  for (const row of rows) {
    for (const key of keysOf(row)) counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const dupKeys = new Set<string>();
  for (const [key, count] of counts) if (count > 1) dupKeys.add(key);
  return dupKeys;
}

function rowHasDupKey(row: SourceRecordRow, dupKeys: Set<string>): boolean {
  const doi = row.parsed?.doi?.trim().toLowerCase();
  const pmid = row.parsed?.pmid?.trim();
  return (doi !== undefined && dupKeys.has(`doi:${doi}`)) || (pmid !== undefined && dupKeys.has(`pmid:${pmid}`));
}

export function BatchDetail({
  projectId,
  batchId,
  onBack,
  onChanged,
}: {
  projectId: string;
  batchId: string;
  onBack: () => void;
  onChanged: () => void;
}) {
  const [batch, setBatch] = useState<ImportBatchDetail | null>(null);
  const [committing, setCommitting] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);

  const load = useCallback(() => {
    api<ImportBatchDetail>(`/api/projects/${projectId}/imports/${batchId}`)
      .then(setBatch)
      .catch((err) =>
        toast.error(err instanceof ApiError ? err.message : "Failed to load import batch"),
      );
  }, [projectId, batchId]);

  useEffect(load, [load]);

  const parsedRows = useMemo(() => (batch?.rows ?? []).filter((r) => r.parsed !== null), [batch]);
  const errorRows = useMemo(
    () => (batch?.rows ?? []).filter((r) => r.parseErrors !== null && r.parseErrors.length > 0),
    [batch],
  );
  const dupKeys = useMemo(() => duplicateKeysInBatch(parsedRows), [parsedRows]);
  const inFileDupCount = useMemo(
    () => parsedRows.filter((r) => rowHasDupKey(r, dupKeys)).length,
    [parsedRows, dupKeys],
  );
  const createdCount = useMemo(
    () => (batch?.rows ?? []).filter((r) => r.citationId !== null).length,
    [batch],
  );

  async function commit() {
    setCommitting(true);
    try {
      const result = await apiPost<CommitResult>(
        `/api/projects/${projectId}/imports/${batchId}/commit`,
      );
      toast.success(`Committed — ${result.citationsCreated.toLocaleString()} citations created`);
      load();
      onChanged();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Failed to commit batch");
    } finally {
      setCommitting(false);
    }
  }

  if (batch === null) {
    return (
      <div className="space-y-4">
        <Button variant="ghost" size="sm" onClick={onBack}>
          <ArrowLeft /> Back to imports
        </Button>
        <Skeleton className="h-8 w-72" />
        <div className="grid gap-4 sm:grid-cols-3">
          <Skeleton className="h-24" />
          <Skeleton className="h-24" />
          <Skeleton className="h-24" />
        </div>
        <Skeleton className="h-64" />
      </div>
    );
  }

  const skippedCount = Math.max(0, batch.totalRecords - batch.failedRecords - createdCount);

  return (
    <div className="space-y-6">
      <div>
        <Button variant="ghost" size="sm" onClick={onBack}>
          <ArrowLeft /> Back to imports
        </Button>
      </div>

      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="flex items-center gap-2.5 text-xl font-semibold tracking-tight">
            {batch.filename}
            <Badge variant={BATCH_STATUS_VARIANT[batch.status]}>
              {batch.status.toLowerCase()}
            </Badge>
          </h1>
          <p className="mt-0.5 text-sm text-muted-foreground">
            {batch.source.name} · {FORMAT_LABELS[batch.format]} · uploaded{" "}
            {new Date(batch.createdAt).toLocaleString()}
            {batch.createdBy ? ` by ${batch.createdBy.name}` : ""}
          </p>
        </div>
        <div className="flex items-center gap-2">
          {batch.status === "PREVIEWED" && (
            <Button onClick={commit} disabled={committing || batch.parsedRecords === 0}>
              {committing && <Spinner />} Commit {batch.parsedRecords.toLocaleString()} records
            </Button>
          )}
          <Button variant="outline" onClick={() => setDeleteOpen(true)}>
            <Trash2 /> Delete import
          </Button>
        </div>
      </div>

      {batch.status === "COMMITTED" && (
        <Alert variant="success">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <span className="flex items-center gap-2">
              <CheckCircle2 className="h-4 w-4 shrink-0" />
              <span>
                Committed{batch.committedAt ? ` ${new Date(batch.committedAt).toLocaleString()}` : ""}:{" "}
                <strong>{createdCount.toLocaleString()}</strong> citations created
                {skippedCount > 0 ? `, ${skippedCount.toLocaleString()} rows skipped` : ""}
                {batch.failedRecords > 0
                  ? `, ${batch.failedRecords.toLocaleString()} failed to parse`
                  : ""}
                .
              </span>
            </span>
            <span className="flex items-center gap-2">
              <Link
                href={`/projects/${projectId}/dedup`}
                className={buttonVariants({ variant: "outline", size: "sm" })}
              >
                Check duplicates
              </Link>
              <Link
                href={`/projects/${projectId}/screening`}
                className={buttonVariants({ variant: "outline", size: "sm" })}
              >
                Go to screening
              </Link>
            </span>
          </div>
        </Alert>
      )}
      {batch.status === "FAILED" && (
        <Alert variant="error">This import batch failed and cannot be committed.</Alert>
      )}

      <div className="grid gap-4 sm:grid-cols-3">
        <StatCard label="Total records" value={batch.totalRecords.toLocaleString()} />
        <StatCard
          label="Parsed"
          value={batch.parsedRecords.toLocaleString()}
          hint={inFileDupCount > 0 ? `${inFileDupCount.toLocaleString()} share a DOI/PMID within this file` : undefined}
        />
        <StatCard label="Parse failures" value={batch.failedRecords.toLocaleString()} />
      </div>

      {errorRows.length > 0 && (
        <section className="space-y-3">
          <h2 className="flex items-center gap-2 text-lg font-medium">
            <FileWarning className="h-4 w-4 text-exclude" /> Parse errors
            <Badge variant="exclude">{errorRows.length.toLocaleString()}</Badge>
          </h2>
          <div className="divide-y divide-border rounded-lg border border-border bg-card">
            {errorRows.slice(0, ERROR_ROW_CAP).map((row) => (
              <div key={row.id} className="px-4 py-3">
                <p className="text-sm">
                  <span className="font-medium">Row {row.rowNumber}</span>{" "}
                  <span className="text-exclude">
                    {(row.parseErrors ?? []).map((e) => e.message).join("; ")}
                  </span>
                </p>
                {row.rawRecord !== "" && (
                  <pre className="mt-1 line-clamp-2 whitespace-pre-wrap font-mono text-xs text-muted-foreground">
                    {row.rawRecord.slice(0, 500)}
                  </pre>
                )}
              </div>
            ))}
            {errorRows.length > ERROR_ROW_CAP && (
              <p className="px-4 py-3 text-sm text-muted-foreground">
                Showing the first {ERROR_ROW_CAP} of {errorRows.length.toLocaleString()} errors.
              </p>
            )}
          </div>
        </section>
      )}

      <section className="space-y-3">
        <h2 className="text-lg font-medium">Parsed records</h2>
        {parsedRows.length === 0 ? (
          <EmptyState
            icon={Inbox}
            title="No parseable records"
            description="Nothing in this file could be parsed — check the format and re-upload."
          />
        ) : (
          <div className="rounded-lg border border-border bg-card">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-12">#</TableHead>
                  <TableHead>Title</TableHead>
                  <TableHead>Authors</TableHead>
                  <TableHead className="w-16">Year</TableHead>
                  <TableHead>DOI</TableHead>
                  <TableHead className="w-24">PMID</TableHead>
                  {batch.status === "COMMITTED" && <TableHead className="w-24">Result</TableHead>}
                </TableRow>
              </TableHeader>
              <TableBody>
                {parsedRows.slice(0, PREVIEW_ROW_CAP).map((row) => (
                  <TableRow key={row.id}>
                    <TableCell className="text-muted-foreground">{row.rowNumber}</TableCell>
                    <TableCell className="max-w-96 font-medium">
                      <span className="line-clamp-2" title={row.parsed?.title}>
                        {row.parsed?.title}
                      </span>
                      {rowHasDupKey(row, dupKeys) && (
                        <Badge variant="maybe" className="mt-1">
                          same DOI/PMID in file
                        </Badge>
                      )}
                    </TableCell>
                    <TableCell className="max-w-56 truncate text-muted-foreground">
                      {formatAuthors(row.parsed?.authors ?? null, 3)}
                    </TableCell>
                    <TableCell className="tabular-nums">{row.parsed?.year ?? "—"}</TableCell>
                    <TableCell className="max-w-44 truncate font-mono text-xs text-muted-foreground">
                      {row.parsed?.doi ?? "—"}
                    </TableCell>
                    <TableCell className="font-mono text-xs text-muted-foreground">
                      {row.parsed?.pmid ?? "—"}
                    </TableCell>
                    {batch.status === "COMMITTED" && (
                      <TableCell>
                        {row.citationId !== null ? (
                          <Badge variant="include">created</Badge>
                        ) : (
                          <Badge variant="muted">skipped</Badge>
                        )}
                      </TableCell>
                    )}
                  </TableRow>
                ))}
              </TableBody>
            </Table>
            {parsedRows.length > PREVIEW_ROW_CAP && (
              <p className="border-t border-border px-4 py-3 text-sm text-muted-foreground">
                Showing the first {PREVIEW_ROW_CAP} of {parsedRows.length.toLocaleString()} parsed
                records — every record is included when you commit.
              </p>
            )}
          </div>
        )}
      </section>
      <DeleteBatchDialog
        projectId={projectId}
        batch={batch}
        open={deleteOpen}
        onOpenChange={setDeleteOpen}
        onDeleted={() => {
          onChanged();
          onBack();
        }}
      />
    </div>
  );
}
