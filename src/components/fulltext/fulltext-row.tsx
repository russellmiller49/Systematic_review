"use client";

import { useCallback, useState } from "react";
import {
  Check,
  ChevronDown,
  ChevronUp,
  DownloadCloud,
  Eye,
  ExternalLink,
  FileText,
  FileX2,
  History,
  Landmark,
  Upload,
  X,
} from "lucide-react";
import { toast } from "sonner";
import { api, apiPost, ApiError } from "@/lib/api";
import { formatAuthors } from "@/components/citations/citation-card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Skeleton } from "@/components/ui/misc";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  ExcludeDialog,
  RetrievalAttemptDialog,
  UploadPdfDialog,
} from "@/components/fulltext/fulltext-dialogs";
import type {
  DecisionResponse,
  ExclusionReason,
  FindPdfResult,
  FullTextQueueItem,
  QueueFileRef,
  RetrievalAttempt,
  RetrievalOutcome,
} from "@/components/fulltext/types";
import { Spinner } from "@/components/ui/misc";

const RETRIEVAL_LABELS: Record<RetrievalOutcome, string> = {
  PENDING: "Awaiting retrieval",
  RETRIEVED: "Retrieved",
  NOT_RETRIEVED: "Not retrieved",
};

const RETRIEVAL_BADGE_VARIANT: Record<RetrievalOutcome, "muted" | "include" | "exclude"> = {
  PENDING: "muted",
  RETRIEVED: "include",
  NOT_RETRIEVED: "exclude",
};

export function FullTextRow({
  projectId,
  item,
  ftStageId,
  exclusionReasons,
  canManageFullText,
  onChanged,
}: {
  projectId: string;
  item: FullTextQueueItem;
  ftStageId: string | null;
  exclusionReasons: ExclusionReason[] | null;
  canManageFullText: boolean;
  onChanged: () => void;
}) {
  const { citation } = item;
  const [expanded, setExpanded] = useState(false);
  const [attempts, setAttempts] = useState<RetrievalAttempt[] | null>(null);
  const [uploadOpen, setUploadOpen] = useState(false);
  const [attemptOutcome, setAttemptOutcome] = useState<RetrievalOutcome | null>(null);
  const [excludeOpen, setExcludeOpen] = useState(false);
  const [preview, setPreview] = useState<QueueFileRef | null>(null);
  const [deciding, setDeciding] = useState(false);
  const [findingPdf, setFindingPdf] = useState(false);

  const loadAttempts = useCallback(() => {
    api<RetrievalAttempt[]>(
      `/api/projects/${projectId}/citations/${citation.id}/retrieval-attempts`,
    )
      .then(setAttempts)
      .catch((err) => {
        setAttempts([]);
        toast.error(
          err instanceof ApiError ? err.message : "Failed to load retrieval attempts",
        );
      });
  }, [projectId, citation.id]);

  function toggleExpanded() {
    const next = !expanded;
    setExpanded(next);
    if (next && attempts === null) loadAttempts();
  }

  function handleAttemptSaved() {
    onChanged();
    if (attempts !== null) loadAttempts();
  }

  async function findPdf() {
    setFindingPdf(true);
    try {
      const res = await apiPost<FindPdfResult>(
        `/api/projects/${projectId}/fulltext/citations/${citation.id}/find-pdf`,
      );
      if (res.outcome === "RETRIEVED") {
        toast.success(`Open-access PDF found via ${res.source ?? "OA sources"}`);
        onChanged();
      } else if (res.outcome === "SKIPPED") {
        toast.info(res.notes);
      } else {
        toast.info("No open-access copy found — try the library links or upload manually.");
        onChanged(); // a NOT_RETRIEVED attempt was recorded
      }
      if (attempts !== null) loadAttempts();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "PDF lookup failed");
    } finally {
      setFindingPdf(false);
    }
  }

  async function includeCitation() {
    if (!ftStageId) return;
    setDeciding(true);
    try {
      const res = await apiPost<DecisionResponse>(
        `/api/projects/${projectId}/screening/stages/${ftStageId}/decisions`,
        { citationId: citation.id, decision: "INCLUDE" },
      );
      toast.success(
        res.result
          ? `Decision saved — citation settled as ${res.result.outcome.toLowerCase()}`
          : "Include decision saved",
      );
      onChanged();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Failed to save decision");
    } finally {
      setDeciding(false);
    }
  }

  const meta = [
    citation.journal,
    citation.year ? String(citation.year) : null,
    citation.volume ? `${citation.volume}${citation.issue ? `(${citation.issue})` : ""}` : null,
    citation.pages,
  ]
    .filter(Boolean)
    .join(" · ");

  const latest = item.latestRetrievalAttempt;

  return (
    <div className="rounded-lg border border-border bg-card p-4 shadow-sm">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <h3 className="text-sm font-semibold leading-snug">{citation.title}</h3>
          <p className="mt-0.5 text-sm text-muted-foreground">
            {formatAuthors(citation.authors)}
            {meta && <span> · {meta}</span>}
          </p>
          {(citation.doi || citation.pmid || item.libraryLinks) && (
            <p className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
              {citation.doi && (
                <a
                  href={`https://doi.org/${citation.doi}`}
                  target="_blank"
                  rel="noreferrer"
                  className="text-primary hover:underline"
                >
                  DOI {citation.doi}
                </a>
              )}
              {citation.pmid && (
                <a
                  href={`https://pubmed.ncbi.nlm.nih.gov/${citation.pmid}/`}
                  target="_blank"
                  rel="noreferrer"
                  className="text-primary hover:underline"
                >
                  PMID {citation.pmid}
                </a>
              )}
              {item.libraryLinks?.proxiedDoiUrl && (
                <a
                  href={item.libraryLinks.proxiedDoiUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex items-center gap-1 text-primary hover:underline"
                  title="Opens the DOI through your institution's proxy — sign in with your library account"
                >
                  <Landmark className="h-3 w-3" /> Library (DOI)
                </a>
              )}
              {item.libraryLinks?.proxiedPubMedUrl && (
                <a
                  href={item.libraryLinks.proxiedPubMedUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex items-center gap-1 text-primary hover:underline"
                  title="Opens PubMed through your institution's proxy"
                >
                  <Landmark className="h-3 w-3" /> Library (PubMed)
                </a>
              )}
              {item.libraryLinks?.openUrlLink && (
                <a
                  href={item.libraryLinks.openUrlLink}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex items-center gap-1 text-primary hover:underline"
                  title="Looks the article up in your institution's link resolver"
                >
                  <Landmark className="h-3 w-3" />
                  Find via {item.libraryLinks.institutionName ?? "your library"}
                </a>
              )}
            </p>
          )}
        </div>
        <div className="flex shrink-0 flex-col items-end gap-1.5">
          <Badge variant={RETRIEVAL_BADGE_VARIANT[item.retrievalStatus]}>
            {RETRIEVAL_LABELS[item.retrievalStatus]}
          </Badge>
          {item.fullTextResult ? (
            <Badge variant={item.fullTextResult.outcome === "INCLUDE" ? "include" : "exclude"}>
              {item.fullTextResult.outcome === "INCLUDE" ? "Included" : "Excluded"} ·{" "}
              {item.fullTextResult.resolvedVia.toLowerCase().replace(/_/g, " ")}
            </Badge>
          ) : item.fullTextDecisionCount > 0 ? (
            <Badge variant="maybe">
              {item.fullTextDecisionCount}{" "}
              {item.fullTextDecisionCount === 1 ? "decision" : "decisions"} in
            </Badge>
          ) : (
            <Badge variant="outline">No decisions yet</Badge>
          )}
        </div>
      </div>

      {(item.files.length > 0 || latest) && (
        <div className="mt-3 space-y-1.5">
          {item.files.length > 0 && (
            <div className="flex flex-wrap items-center gap-1.5">
              {item.files.map((f) => (
                <span
                  key={f.id}
                  className="inline-flex items-center gap-1 rounded-md border border-border bg-muted/50 px-2 py-1 text-xs"
                >
                  <a
                    href={`/api/files/${f.id}`}
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex max-w-[16rem] items-center gap-1 hover:underline"
                    title="Open PDF in a new tab"
                  >
                    <FileText className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                    <span className="truncate">{f.filename}</span>
                    {f.label && <span className="text-muted-foreground">({f.label})</span>}
                  </a>
                  <button
                    type="button"
                    onClick={() => setPreview(f)}
                    className="rounded p-0.5 text-muted-foreground hover:bg-muted hover:text-foreground"
                    title="Preview inline"
                  >
                    <Eye className="h-3.5 w-3.5" />
                    <span className="sr-only">Preview {f.filename}</span>
                  </button>
                </span>
              ))}
            </div>
          )}
          {latest && (
            <p className="text-xs text-muted-foreground">
              Last attempt: {RETRIEVAL_LABELS[latest.outcome].toLowerCase()} via {latest.method} ·{" "}
              {latest.recordedBy.name} · {new Date(latest.attemptedAt).toLocaleDateString()}
            </p>
          )}
        </div>
      )}

      <div className="mt-3 flex flex-wrap items-center justify-between gap-2 border-t border-border pt-3">
        <div className="flex flex-wrap items-center gap-2">
          {canManageFullText && (
            <>
              {item.files.length === 0 && (citation.doi || citation.pmid) && (
                <Button
                  variant="outline"
                  size="sm"
                  disabled={findingPdf}
                  onClick={() => void findPdf()}
                  title="Search Unpaywall and Europe PMC for a legal open-access PDF"
                >
                  {findingPdf ? <Spinner className="h-3.5 w-3.5" /> : <DownloadCloud />} Find PDF
                </Button>
              )}
              <Button variant="outline" size="sm" onClick={() => setUploadOpen(true)}>
                <Upload /> Upload PDF
              </Button>
              <Button variant="outline" size="sm" onClick={() => setAttemptOutcome("RETRIEVED")}>
                <Check /> Mark retrieved
              </Button>
              <Button variant="outline" size="sm" onClick={() => setAttemptOutcome("NOT_RETRIEVED")}>
                <FileX2 /> Not retrievable
              </Button>
            </>
          )}
          <Button variant="ghost" size="sm" onClick={toggleExpanded}>
            <History /> Attempts {expanded ? <ChevronUp /> : <ChevronDown />}
          </Button>
        </div>
        {item.fullTextResult ? (
          <p className="text-xs text-muted-foreground">
            Settled {new Date(item.fullTextResult.resolvedAt).toLocaleDateString()}
          </p>
        ) : item.myAssignmentStatus === "PENDING" ? (
          <div className="flex items-center gap-2">
            <Button
              variant="include"
              size="sm"
              disabled={deciding || !ftStageId}
              title={ftStageId ? undefined : "Full-text stage unavailable"}
              onClick={includeCitation}
            >
              <Check /> Include
            </Button>
            <Button
              variant="exclude"
              size="sm"
              disabled={deciding || !ftStageId}
              title={ftStageId ? undefined : "Full-text stage unavailable"}
              onClick={() => setExcludeOpen(true)}
            >
              <X /> Exclude…
            </Button>
          </div>
        ) : (
          <p className="text-xs text-muted-foreground">
            {item.myAssignmentStatus === "COMPLETED"
              ? "Your screening decision is complete"
              : "No screening task assigned to you"}
          </p>
        )}
      </div>

      {expanded && (
        <div className="mt-3 space-y-4 border-t border-border pt-3">
          {citation.abstract && (
            <div>
              <h4 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                Abstract
              </h4>
              <p className="mt-1 whitespace-pre-line text-sm leading-relaxed text-foreground/90">
                {citation.abstract}
              </p>
            </div>
          )}
          <div>
            <h4 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
              Retrieval attempts
            </h4>
            {attempts === null ? (
              <Skeleton className="mt-2 h-16" />
            ) : attempts.length === 0 ? (
              <p className="mt-1 text-sm text-muted-foreground">
                No retrieval attempts recorded yet.
              </p>
            ) : (
              <Table className="mt-2">
                <TableHeader>
                  <TableRow>
                    <TableHead>Outcome</TableHead>
                    <TableHead>Method</TableHead>
                    <TableHead>Notes</TableHead>
                    <TableHead>Recorded by</TableHead>
                    <TableHead>When</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {attempts.map((a) => (
                    <TableRow key={a.id}>
                      <TableCell>
                        <Badge variant={RETRIEVAL_BADGE_VARIANT[a.outcome]}>
                          {RETRIEVAL_LABELS[a.outcome]}
                        </Badge>
                      </TableCell>
                      <TableCell>{a.method}</TableCell>
                      <TableCell className="max-w-[18rem] text-muted-foreground">
                        {a.notes ?? "—"}
                      </TableCell>
                      <TableCell>{a.recordedBy.name}</TableCell>
                      <TableCell className="whitespace-nowrap text-muted-foreground">
                        {new Date(a.attemptedAt).toLocaleString()}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </div>
        </div>
      )}

      {canManageFullText && (
        <>
          <UploadPdfDialog
            projectId={projectId}
            citationId={citation.id}
            open={uploadOpen}
            onOpenChange={setUploadOpen}
            onUploaded={onChanged}
          />
          <RetrievalAttemptDialog
            projectId={projectId}
            citationId={citation.id}
            open={attemptOutcome !== null}
            defaultOutcome={attemptOutcome ?? "RETRIEVED"}
            onOpenChange={(open) => {
              if (!open) setAttemptOutcome(null);
            }}
            onSaved={handleAttemptSaved}
          />
        </>
      )}
      {ftStageId && (
        <ExcludeDialog
          projectId={projectId}
          stageId={ftStageId}
          citationId={citation.id}
          reasons={exclusionReasons}
          open={excludeOpen}
          onOpenChange={setExcludeOpen}
          onDecided={onChanged}
        />
      )}
      {preview && (
        <PdfPreviewDialog file={preview} onClose={() => setPreview(null)} />
      )}
    </div>
  );
}

function PdfPreviewDialog({ file, onClose }: { file: QueueFileRef; onClose: () => void }) {
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-4xl">
        <DialogHeader>
          <DialogTitle className="truncate pr-8">{file.filename}</DialogTitle>
          <DialogDescription>
            <a
              href={`/api/files/${file.id}`}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1 text-primary hover:underline"
            >
              <ExternalLink className="h-3.5 w-3.5" /> Open in a new tab
            </a>
          </DialogDescription>
        </DialogHeader>
        <iframe
          src={`/api/files/${file.id}`}
          title={file.filename}
          className="h-[70vh] w-full rounded-md border border-border bg-muted"
        />
      </DialogContent>
    </Dialog>
  );
}
