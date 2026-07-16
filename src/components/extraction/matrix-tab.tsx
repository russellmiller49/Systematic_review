"use client";

// The "living extraction table": rows = studies, columns = template fields, each cell
// showing the resolved value (adjudicated > agreed > single) with a provenance badge and,
// in a popover, every visible extractor entry with its quote/page evidence and an
// "Open PDF" jump to the anchored page. Blinding is server-enforced (the matrix endpoint
// mirrors listForms); this component just renders what the caller may see.

import { useCallback, useEffect, useMemo, useState } from "react";
import Papa from "papaparse";
import { Anchor, Download, ExternalLink, FileText, RefreshCw } from "lucide-react";
import { toast } from "sonner";
import { api, apiPost, ApiError } from "@/lib/api";
import type { SourceAnchorV2 } from "@/types/source-anchor";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { PdfEvidenceViewer } from "@/components/pdf/pdf-evidence-viewer";
import { EmptyState, Skeleton, Spinner } from "@/components/ui/misc";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Select } from "@/components/ui/select";
import { formatFieldValue, hasCap, readSourceAnchor, type Template } from "./types";

// --- Server payload types (mirror src/server/services/extraction/matrix.ts) ----

interface MatrixEntry {
  formId: string;
  extractor: { id: string; name: string };
  formStatus: "IN_PROGRESS" | "COMPLETED";
  value: unknown;
  sourceQuote: string | null;
  pageNumber: number | null;
  sourceAnchor: unknown;
  updatedAt: string;
}

interface MatrixCell {
  resolved: { value: unknown; source: "ADJUDICATED" | "AGREED" | "SINGLE" } | null;
  disputed: boolean;
  entries: MatrixEntry[];
  adjudication?: {
    finalValue: unknown;
    reason: string;
    adjudicator: { id: string; name: string };
  };
}

interface MatrixField {
  id: string;
  key: string;
  label: string;
  type: Template["fields"][number]["type"];
  section: string | null;
  order: number;
  options: { value: string; label: string }[];
}

interface MatrixStudyRow {
  id: string;
  label: string;
  inQuantitativeSynthesis: boolean;
  pdf: { fileId: string; filename: string } | null;
  cells: Record<string, MatrixCell>;
}

interface ExtractionMatrixResponse {
  template: { id: string; name: string; version: number; status: string };
  fields: MatrixField[];
  seeAll: boolean;
  studies: MatrixStudyRow[];
}

const SOURCE_BADGE: Record<
  "ADJUDICATED" | "AGREED" | "SINGLE",
  { label: string; variant: "include" | "secondary" | "muted" }
> = {
  ADJUDICATED: { label: "Adjudicated", variant: "include" },
  AGREED: { label: "Agreed", variant: "secondary" },
  SINGLE: { label: "Single", variant: "muted" },
};

interface EvidenceTarget {
  fileId: string;
  page: number | null;
  quote: string | null;
  anchor: SourceAnchorV2 | null;
  filename: string;
  studyLabel: string;
}

// POST /extraction/reanchor coverage report (mirrors ReanchorReport server-side).
interface ReanchorReport {
  total: number;
  exact: number;
  fuzzy: number;
  pageOnly: number;
  noPdf: number;
  noTextLayer: number;
}

export function MatrixTab({
  projectId,
  templates,
}: {
  projectId: string;
  templates: Template[] | null;
}) {
  // Default to the published template (the one being extracted against).
  const selectable = useMemo(
    () => (templates ?? []).filter((t) => t.status !== "ARCHIVED"),
    [templates],
  );
  const [templateId, setTemplateId] = useState<string>("");
  const effectiveTemplateId =
    templateId || selectable.find((t) => t.status === "PUBLISHED")?.id || selectable[0]?.id || "";

  const [matrix, setMatrix] = useState<ExtractionMatrixResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [evidence, setEvidence] = useState<EvidenceTarget | null>(null);
  // Re-anchor backfill is managerial (project.edit) — the tab itself isn't handed
  // capability info, so gate on the project payload's roles like the page header does.
  const [roles, setRoles] = useState<string[] | null>(null);
  const [reanchoring, setReanchoring] = useState(false);

  useEffect(() => {
    let cancelled = false;
    api<{ myRoles: string[] }>(`/api/projects/${projectId}`)
      .then((p) => {
        if (!cancelled) setRoles(p.myRoles);
      })
      .catch(() => {
        if (!cancelled) setRoles(null); // silent: the button simply stays hidden
      });
    return () => {
      cancelled = true;
    };
  }, [projectId]);

  const load = useCallback(() => {
    if (!effectiveTemplateId) return;
    setLoading(true);
    api<ExtractionMatrixResponse>(
      `/api/projects/${projectId}/extraction/matrix?templateId=${effectiveTemplateId}`,
    )
      .then(setMatrix)
      .catch(() => {
        setMatrix(null);
        toast.error("Failed to load the extraction table");
      })
      .finally(() => setLoading(false));
  }, [projectId, effectiveTemplateId]);

  useEffect(load, [load]);

  // Keep the table current while extraction proceeds elsewhere: refetch on window focus
  // and on a slow interval (no websockets in this stack).
  useEffect(() => {
    const onFocus = () => load();
    window.addEventListener("focus", onFocus);
    const interval = window.setInterval(load, 60_000);
    return () => {
      window.removeEventListener("focus", onFocus);
      window.clearInterval(interval);
    };
  }, [load]);

  // Backfill v2 anchors for every quoted value of this template, then surface the
  // coverage report ({total, exact, fuzzy, pageOnly, noPdf, noTextLayer}) in a toast.
  async function reanchor() {
    if (!effectiveTemplateId) return;
    setReanchoring(true);
    try {
      const report = await apiPost<ReanchorReport>(
        `/api/projects/${projectId}/extraction/reanchor`,
        { templateId: effectiveTemplateId },
      );
      if (report.total === 0) {
        toast.info("No quoted evidence to re-anchor for this template.");
      } else {
        const parts = [
          `${report.exact} exact`,
          `${report.fuzzy} fuzzy`,
          `${report.pageOnly} page-only`,
        ];
        if (report.noPdf > 0) parts.push(`${report.noPdf} without a PDF`);
        if (report.noTextLayer > 0) parts.push(`${report.noTextLayer} without a text layer`);
        toast.success(`Re-anchored ${report.total} quotes — ${parts.join(", ")}.`);
      }
      load(); // anchors changed → refresh the entries backing "Open in PDF"
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Failed to re-anchor evidence");
    } finally {
      setReanchoring(false);
    }
  }

  function exportCsv() {
    if (!matrix) return;
    const header = ["Study", ...matrix.fields.map((f) => f.label)];
    const rows = matrix.studies.map((study) => [
      study.label,
      ...matrix.fields.map((f) => {
        const cell = study.cells[f.id];
        if (!cell) return "";
        if (cell.resolved) return formatFieldValue(f, cell.resolved.value);
        if (cell.disputed) return "(disputed)";
        const inProgress = cell.entries[0];
        return inProgress ? formatFieldValue(f, inProgress.value) : "";
      }),
    ]);
    const csv = Papa.unparse({ fields: header, data: rows });
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `extraction-table-${matrix.template.name.replaceAll(/\s+/g, "-").toLowerCase()}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  if (templates === null) {
    return <Skeleton className="h-40" />;
  }
  if (selectable.length === 0) {
    return (
      <EmptyState
        title="No extraction templates yet"
        description="Create and publish a template on the Templates tab — the table view fills in as data is extracted."
      />
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end gap-3">
        <div className="space-y-1.5">
          <Label htmlFor="matrix-template">Template</Label>
          <Select
            id="matrix-template"
            className="w-64"
            value={effectiveTemplateId}
            onChange={(e) => setTemplateId(e.target.value)}
          >
            {selectable.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name} (v{t.version}
                {t.status !== "PUBLISHED" ? `, ${t.status.toLowerCase()}` : ""})
              </option>
            ))}
          </Select>
        </div>
        <div className="flex-1" />
        {matrix && !matrix.seeAll && (
          <p className="text-xs text-muted-foreground">
            Showing your own extraction only — adjudicators and admins see all extractors.
          </p>
        )}
        {hasCap(roles, "project.edit") && (
          <Button
            variant="outline"
            size="sm"
            onClick={() => void reanchor()}
            disabled={reanchoring || !effectiveTemplateId}
            title="Locate every recorded quote in its study's PDF and store the anchors"
          >
            {reanchoring ? <Spinner className="h-3.5 w-3.5" /> : <Anchor />} Re-anchor evidence
          </Button>
        )}
        <Button variant="outline" size="sm" onClick={load} disabled={loading}>
          {loading ? <Spinner className="h-3.5 w-3.5" /> : <RefreshCw />} Refresh
        </Button>
        <Button variant="outline" size="sm" onClick={exportCsv} disabled={!matrix}>
          <Download /> Export CSV
        </Button>
      </div>

      {!matrix ? (
        <Skeleton className="h-64" />
      ) : matrix.studies.length === 0 ? (
        <EmptyState
          title="No studies yet"
          description="Studies appear here once full-text inclusions create them."
        />
      ) : (
        <div className="overflow-x-auto rounded-lg border border-border">
          <table className="w-full min-w-max border-collapse text-sm">
            <thead>
              <tr className="bg-muted/50">
                <th className="sticky left-0 z-10 border-b border-r border-border bg-muted px-3 py-2 text-left font-medium">
                  Study
                </th>
                {matrix.fields.map((f) => (
                  <th
                    key={f.id}
                    className="min-w-36 max-w-56 border-b border-border px-3 py-2 text-left align-bottom font-medium"
                    title={f.section ? `${f.section} · ${f.label}` : f.label}
                  >
                    <span className="line-clamp-2">{f.label}</span>
                    {f.section && (
                      <span className="block text-xs font-normal text-muted-foreground">
                        {f.section}
                      </span>
                    )}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {matrix.studies.map((study) => (
                <tr key={study.id} className="group">
                  <td className="sticky left-0 z-10 border-b border-r border-border bg-background px-3 py-2 font-medium group-hover:bg-muted/30">
                    <div className="flex items-center gap-1.5">
                      <span className="whitespace-nowrap">{study.label}</span>
                      {study.pdf && (
                        <FileText
                          className="h-3.5 w-3.5 shrink-0 text-muted-foreground"
                          aria-label="PDF available"
                        />
                      )}
                    </div>
                  </td>
                  {matrix.fields.map((f) => (
                    <td
                      key={f.id}
                      className="border-b border-border px-3 py-2 align-top group-hover:bg-muted/30"
                    >
                      <MatrixCellView
                        cell={study.cells[f.id]}
                        field={f}
                        study={study}
                        onOpenEvidence={setEvidence}
                      />
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <Dialog open={evidence !== null} onOpenChange={(open) => !open && setEvidence(null)}>
        <DialogContent className="max-w-4xl">
          {evidence && (
            <>
              <DialogHeader>
                <DialogTitle>{evidence.studyLabel}</DialogTitle>
                <DialogDescription>
                  {evidence.filename}
                  {evidence.page ? ` — page ${evidence.page}` : ""}
                </DialogDescription>
              </DialogHeader>
              {evidence.quote && (
                <p className="border-l-2 border-border pl-3 text-sm italic text-muted-foreground">
                  &ldquo;{evidence.quote}&rdquo;
                  {evidence.page ? ` (p. ${evidence.page})` : ""}
                </p>
              )}
              <PdfEvidenceViewer
                target={{
                  fileId: evidence.fileId,
                  page: evidence.page,
                  quote: evidence.quote,
                  anchor: evidence.anchor,
                }}
                heightClass="h-[65vh]"
              />
            </>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}

function MatrixCellView({
  cell,
  field,
  study,
  onOpenEvidence,
}: {
  cell: MatrixCell | undefined;
  field: MatrixField;
  study: MatrixStudyRow;
  onOpenEvidence: (target: EvidenceTarget) => void;
}) {
  if (!cell || (cell.entries.length === 0 && !cell.disputed && !cell.resolved)) {
    return <span className="text-muted-foreground">—</span>;
  }

  const display = cell.resolved
    ? formatFieldValue(field, cell.resolved.value)
    : cell.disputed
      ? "Disputed"
      : formatFieldValue(field, cell.entries[0]?.value);
  const badge = cell.resolved ? SOURCE_BADGE[cell.resolved.source] : null;
  const hasEvidence = cell.entries.some((e) => e.sourceQuote || e.pageNumber !== null);

  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          className="block w-full rounded px-1 py-0.5 text-left hover:bg-muted focus:outline-none focus:ring-1 focus:ring-ring"
          aria-label={`${study.label} — ${field.label}`}
        >
          <span className={cell.disputed && !cell.resolved ? "italic text-exclude" : ""}>
            {display}
          </span>
          <span className="mt-0.5 flex items-center gap-1">
            {badge && (
              <Badge variant={badge.variant} className="px-1 py-0 text-[10px]">
                {badge.label}
              </Badge>
            )}
            {cell.disputed && !cell.resolved && (
              <Badge variant="exclude" className="px-1 py-0 text-[10px]">
                Conflict
              </Badge>
            )}
            {hasEvidence && (
              <span className="h-1.5 w-1.5 rounded-full bg-include" aria-label="Has evidence" />
            )}
          </span>
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-96 space-y-3">
        <p className="font-medium">{field.label}</p>
        {cell.adjudication && (
          <div className="rounded-md border border-border bg-muted/50 p-2 text-xs">
            <p>
              <span className="font-medium">Adjudicated:</span>{" "}
              {formatFieldValue(field, cell.adjudication.finalValue)} by{" "}
              {cell.adjudication.adjudicator.name}
            </p>
            <p className="mt-1 text-muted-foreground">{cell.adjudication.reason}</p>
          </div>
        )}
        {cell.entries.length === 0 && (
          <p className="text-xs text-muted-foreground">No visible extractor entries.</p>
        )}
        {cell.entries.map((entry) => {
          // Anchors are file-scoped: ignore one that points at a different PDF than the
          // study's current file (re-linked PDFs must not hijack the page hint).
          const parsed = readSourceAnchor(entry.sourceAnchor);
          const anchor = parsed !== null && parsed.fileId === study.pdf?.fileId ? parsed : null;
          const page = anchor?.page ?? entry.pageNumber;
          return (
            <div key={entry.formId} className="space-y-1 border-t border-border pt-2 text-xs">
              <div className="flex flex-wrap items-center gap-1.5">
                <span className="font-medium">{entry.extractor.name}</span>
                <Badge
                  variant={entry.formStatus === "COMPLETED" ? "include" : "maybe"}
                  className="px-1 py-0 text-[10px]"
                >
                  {entry.formStatus === "COMPLETED" ? "completed" : "in progress"}
                </Badge>
                <span className="grow" />
                <span>{formatFieldValue(field, entry.value)}</span>
              </div>
              {entry.sourceQuote && (
                <p className="border-l-2 border-border pl-2 italic text-muted-foreground">
                  &ldquo;{entry.sourceQuote}&rdquo;
                  {entry.pageNumber ? ` (p. ${entry.pageNumber})` : ""}
                </p>
              )}
              {study.pdf && (entry.sourceQuote || page !== null) && (
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-6 px-1.5 text-xs"
                  onClick={() =>
                    onOpenEvidence({
                      fileId: study.pdf!.fileId,
                      filename: study.pdf!.filename,
                      page,
                      quote: entry.sourceQuote,
                      anchor,
                      studyLabel: study.label,
                    })
                  }
                >
                  <ExternalLink className="h-3 w-3" /> Open in PDF
                </Button>
              )}
            </div>
          );
        })}
      </PopoverContent>
    </Popover>
  );
}
