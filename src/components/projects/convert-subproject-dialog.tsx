"use client";

import { useState } from "react";
import { FolderInput } from "lucide-react";
import { toast } from "sonner";
import { api, apiPost, ApiError } from "@/lib/api";
import { Badge } from "@/components/ui/badge";
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
import { Alert, EmptyState, Skeleton, Spinner } from "@/components/ui/misc";
import { cn } from "@/lib/utils";

interface ConvertibleProject {
  id: string;
  title: string;
  reviewType: string;
  researchQuestion: string | null;
  description: string | null;
  status: string;
  protocol: { reviewQuestion: string | null } | null;
  manuscript: {
    id: string;
    usesPicoDefaultSections: boolean;
    sections: {
      title: string;
      kind: string;
      order: number;
      wordCount: number;
      _count: { comments: number; versions: number };
    }[];
  } | null;
  _count: {
    citations: number;
    studies: number;
    referenceEntries: number;
    members: number;
  };
}

export function ConvertSubProjectDialog({
  projectId,
  onConverted,
}: {
  projectId: string;
  onConverted?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [projects, setProjects] = useState<ConvertibleProject[] | null>(null);
  const [selectedId, setSelectedId] = useState("");
  const [manuscriptChoice, setManuscriptChoice] = useState<"KEEP" | "RESET">("KEEP");
  const [acceptedDataLoss, setAcceptedDataLoss] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const selected = projects?.find((project) => project.id === selectedId) ?? null;
  const canResetManuscript =
    selected?.manuscript !== null &&
    selected?.manuscript !== undefined &&
    !selected.manuscript.usesPicoDefaultSections;
  const willResetManuscript = canResetManuscript && manuscriptChoice === "RESET";
  const manuscriptSectionCount = selected?.manuscript?.sections.length ?? 0;
  const manuscriptWordCount =
    selected?.manuscript?.sections.reduce((sum, section) => sum + section.wordCount, 0) ?? 0;
  const manuscriptCommentCount =
    selected?.manuscript?.sections.reduce(
      (sum, section) => sum + section._count.comments,
      0,
    ) ?? 0;
  const manuscriptVersionCount =
    selected?.manuscript?.sections.reduce(
      (sum, section) => sum + section._count.versions,
      0,
    ) ?? 0;

  function loadProjects() {
    setProjects(null);
    setSelectedId("");
    setManuscriptChoice("KEEP");
    setAcceptedDataLoss(false);
    setError(null);
    api<ConvertibleProject[]>(`/api/projects/${projectId}/subprojects/convert`)
      .then(setProjects)
      .catch((err) => {
        setProjects([]);
        setError(err instanceof ApiError ? err.message : "Failed to load existing projects");
      });
  }

  async function convert() {
    if (!selectedId) return;
    if (willResetManuscript && !acceptedDataLoss) return;
    setBusy(true);
    setError(null);
    try {
      await apiPost(`/api/projects/${projectId}/subprojects/convert`, {
        sourceProjectId: selectedId,
        resetManuscriptToPicoDefaults: willResetManuscript,
        ...(willResetManuscript
          ? { confirmManuscriptDataLoss: acceptedDataLoss }
          : {}),
      });
      toast.success("Existing project converted to a PICO sub-project");
      setOpen(false);
      onConverted?.();
    } catch (err) {
      const message = err instanceof ApiError ? err.message : "Failed to convert project";
      setError(message);
      toast.error(message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (next) {
          setBusy(false);
          loadProjects();
        }
      }}
    >
      <DialogTrigger asChild>
        <Button variant="outline">
          <FolderInput /> Add existing project
        </Button>
      </DialogTrigger>
      <DialogContent className="max-h-[85vh] max-w-2xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Convert an existing project</DialogTitle>
          <DialogDescription>
            Choose a standalone project that you own in this workspace and make it a PICO
            sub-project of this guideline.
          </DialogDescription>
        </DialogHeader>

        {error && <Alert variant="error">{error}</Alert>}

        {projects === null ? (
          <div className="space-y-3">
            <Skeleton className="h-24" />
            <Skeleton className="h-24" />
          </div>
        ) : projects.length === 0 && !error ? (
          <EmptyState
            icon={FolderInput}
            title="No eligible projects"
            description="Only standalone projects that you own in this workspace can be converted."
          />
        ) : projects.length > 0 ? (
          <div className="space-y-2" role="radiogroup" aria-label="Project to convert">
            {projects.map((project) => {
              const question = project.researchQuestion ?? project.protocol?.reviewQuestion;
              const selectedProject = selectedId === project.id;
              return (
                <label
                  key={project.id}
                  className={cn(
                    "block cursor-pointer rounded-lg border p-4 transition-colors",
                    selectedProject
                      ? "border-primary bg-primary/5 ring-1 ring-primary"
                      : "border-border hover:bg-muted/50",
                  )}
                >
                  <span className="flex items-start gap-3">
                    <input
                      type="radio"
                      name="convert-project"
                      value={project.id}
                      checked={selectedProject}
                      onChange={() => {
                        setSelectedId(project.id);
                        setManuscriptChoice("KEEP");
                        setAcceptedDataLoss(false);
                      }}
                      className="mt-1 h-4 w-4 accent-[var(--color-primary)]"
                    />
                    <span className="min-w-0 flex-1">
                      <span className="flex flex-wrap items-center gap-2">
                        <span className="font-medium">{project.title}</span>
                        <Badge variant="muted">{project.status.toLowerCase()}</Badge>
                      </span>
                      {question && (
                        <span className="mt-1 line-clamp-2 block text-sm text-muted-foreground">
                          {question}
                        </span>
                      )}
                      <span className="mt-2 block text-xs text-muted-foreground">
                        {project._count.citations} citations · {project._count.studies} studies ·{" "}
                        {project._count.referenceEntries} references ·{" "}
                        {project._count.members} members
                      </span>
                    </span>
                  </span>
                </label>
              );
            })}
          </div>
        ) : null}

        {selected && (
          <>
            <Alert variant="warning">
              <span className="font-medium">What will change:</span> “{selected.title}” will
              move under this guideline and its references will join the shared library.
              Missing guideline members will be added with their current guideline roles. Its
              protocol, citations, decisions, files, extraction, analysis, settings, and
              existing team will stay intact. This structural change cannot currently be
              undone in the app.
            </Alert>

            {!selected.manuscript ? (
              <Alert>
                A manuscript has not been started. The five PICO default sections will be
                created automatically the first time its manuscript is opened.
              </Alert>
            ) : selected.manuscript.usesPicoDefaultSections ? (
              <Alert variant="success">
                This manuscript already uses the five PICO default sections and will stay
                intact.
              </Alert>
            ) : (
              <fieldset className="space-y-3 rounded-md border border-border p-4">
                <legend className="px-1 text-sm font-medium">Manuscript section layout</legend>
                <label className="flex items-start gap-2 text-sm">
                  <input
                    type="radio"
                    name="manuscript-conversion"
                    className="mt-0.5 h-4 w-4 accent-[var(--color-primary)]"
                    checked={manuscriptChoice === "KEEP"}
                    onChange={() => {
                      setManuscriptChoice("KEEP");
                      setAcceptedDataLoss(false);
                    }}
                  />
                  <span>
                    Keep the current manuscript
                    <span className="block text-xs text-muted-foreground">
                      Preserve all {manuscriptSectionCount} sections, writing, comments, and
                      version history.
                    </span>
                  </span>
                </label>
                <label className="flex items-start gap-2 text-sm">
                  <input
                    type="radio"
                    name="manuscript-conversion"
                    className="mt-0.5 h-4 w-4 accent-[var(--color-destructive)]"
                    checked={manuscriptChoice === "RESET"}
                    onChange={() => {
                      setManuscriptChoice("RESET");
                      setAcceptedDataLoss(false);
                    }}
                  />
                  <span>
                    Replace with PICO defaults
                    <span className="block text-xs text-muted-foreground">
                      Start with Question, Evidence summary, Certainty of evidence,
                      Recommendation, and Rationale and considerations.
                    </span>
                  </span>
                </label>

                {willResetManuscript && (
                  <Alert variant="error">
                    <p className="font-semibold">Manuscript data will be permanently deleted.</p>
                    <p className="mt-1">
                      The current {manuscriptSectionCount} sections and all written content
                      {manuscriptWordCount > 0
                        ? ` (${manuscriptWordCount.toLocaleString()} words)`
                        : ""}
                      , {manuscriptCommentCount} comments, {manuscriptVersionCount} saved
                      versions, assignments, review statuses, and active edit locks will be
                      removed. This cannot be undone. Other review data and the reference
                      library are unaffected.
                    </p>
                    <label className="mt-3 flex items-start gap-2 rounded-md border border-exclude/30 bg-background/60 p-3">
                      <input
                        type="checkbox"
                        className="mt-0.5 h-4 w-4 accent-[var(--color-destructive)]"
                        checked={acceptedDataLoss}
                        onChange={(event) => setAcceptedDataLoss(event.target.checked)}
                      />
                      <span>
                        I understand that the current manuscript sections and their data will
                        be deleted.
                      </span>
                    </label>
                  </Alert>
                )}
              </fieldset>
            )}
          </>
        )}

        <DialogFooter>
          <Button
            variant={willResetManuscript ? "destructive" : "default"}
            onClick={convert}
            disabled={
              busy ||
              !selectedId ||
              projects === null ||
              (willResetManuscript && !acceptedDataLoss)
            }
          >
            {busy && <Spinner />} Convert to PICO sub-project
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
