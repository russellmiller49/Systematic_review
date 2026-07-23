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
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const selected = projects?.find((project) => project.id === selectedId) ?? null;

  function loadProjects() {
    setProjects(null);
    setSelectedId("");
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
    setBusy(true);
    setError(null);
    try {
      await apiPost(`/api/projects/${projectId}/subprojects/convert`, {
        sourceProjectId: selectedId,
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
                      onChange={() => setSelectedId(project.id)}
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
          <Alert variant="warning">
            <span className="font-medium">What will change:</span> “{selected.title}” will move
            under this guideline and its references will join the shared library. Missing
            guideline members will be added with their current guideline roles. Its protocol,
            citations, decisions, files, extraction, analysis, manuscript, settings, and
            existing team will stay intact. This structural change cannot currently be undone
            in the app.
          </Alert>
        )}

        <DialogFooter>
          <Button onClick={convert} disabled={busy || !selectedId || projects === null}>
            {busy && <Spinner />} Convert to PICO sub-project
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
