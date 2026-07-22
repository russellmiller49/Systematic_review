"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { BookOpenText, FileDown, ListTree } from "lucide-react";
import { toast } from "sonner";
import { api, ApiError } from "@/lib/api";
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
import { Alert, Skeleton } from "@/components/ui/misc";

interface CompiledSection {
  id: string;
  title: string;
  kind: string;
  status: string;
  wordCount: number;
}

interface CompiledPart {
  projectId: string;
  projectTitle: string;
  researchQuestion: string | null;
  isParent: boolean;
  picoNumber: number | null;
  sections: CompiledSection[];
}

interface CompiledGuideline {
  title: string;
  canExportAll: boolean;
  parts: CompiledPart[];
  skipped: { projectId: string; projectTitle: string }[];
  totalWordCount: number;
}

const STATUS_VARIANTS: Record<string, "muted" | "secondary" | "include"> = {
  DRAFT: "muted",
  IN_REVIEW: "secondary",
  APPROVED: "include",
};

// Outline of the full guideline document (general sections + every PICO's sections)
// with the one-click whole-guideline DOCX export.
export function GuidelineCompileDialog({ projectId }: { projectId: string }) {
  const [open, setOpen] = useState(false);
  const [data, setData] = useState<CompiledGuideline | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setData(null);
    setError(null);
    api<CompiledGuideline>(`/api/projects/${projectId}/manuscript/compiled`)
      .then(setData)
      .catch((err) => {
        const message =
          err instanceof ApiError ? err.message : "Failed to load the compiled guideline";
        setError(message);
        toast.error(message);
      });
  }, [open, projectId]);

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="outline" size="sm">
          <BookOpenText /> Compiled guideline
        </Button>
      </DialogTrigger>
      <DialogContent className="max-h-[85vh] max-w-2xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Compiled guideline</DialogTitle>
          <DialogDescription>
            The full document in order: the guideline&apos;s general sections, then each PICO
            question&apos;s sections, with one bibliography numbered across everything.
          </DialogDescription>
        </DialogHeader>

        {error ? (
          <Alert variant="error">{error}</Alert>
        ) : data === null ? (
          <Skeleton className="h-64" />
        ) : (
          <div className="space-y-4">
            {data.skipped.length > 0 && (
              <Alert variant="warning">
                You don&apos;t have manuscript access to{" "}
                {data.skipped.map((s) => s.projectTitle).join(", ")} — those sections are not
                shown, and the full export needs access to every PICO sub-project.
              </Alert>
            )}
            {data.parts.map((part) => (
              <div key={part.projectId} className="rounded-md border border-border">
                <div className="flex flex-wrap items-baseline justify-between gap-2 border-b border-border bg-muted/40 px-3 py-2">
                  <p className="text-sm font-medium">
                    {part.isParent ? (
                      <span className="flex items-center gap-1.5">
                        <ListTree className="h-4 w-4 text-muted-foreground" />
                        General sections
                      </span>
                    ) : (
                      `PICO ${part.picoNumber}. ${part.projectTitle}`
                    )}
                  </p>
                  {!part.isParent && (
                    <Link
                      href={`/projects/${part.projectId}/manuscript`}
                      className="text-xs text-primary hover:underline"
                    >
                      Open manuscript
                    </Link>
                  )}
                </div>
                {part.researchQuestion && !part.isParent && (
                  <p className="border-b border-border px-3 py-1.5 text-xs italic text-muted-foreground">
                    {part.researchQuestion}
                  </p>
                )}
                <ul className="divide-y divide-border">
                  {part.sections.map((s) => (
                    <li key={s.id} className="flex items-center justify-between gap-2 px-3 py-1.5">
                      <span className="truncate text-sm">{s.title}</span>
                      <span className="flex shrink-0 items-center gap-2">
                        <span className="text-xs tabular-nums text-muted-foreground">
                          {s.wordCount} words
                        </span>
                        <Badge variant={STATUS_VARIANTS[s.status] ?? "muted"}>
                          {s.status.replace(/_/g, " ").toLowerCase()}
                        </Badge>
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
            <p className="text-xs text-muted-foreground">
              {data.totalWordCount} words across {data.parts.length} part
              {data.parts.length === 1 ? "" : "s"}.
            </p>
          </div>
        )}

        <DialogFooter>
          <Button
            disabled={data === null || !data.canExportAll}
            title={
              data && !data.canExportAll
                ? "You need manuscript access to every PICO sub-project to export the full guideline"
                : undefined
            }
            onClick={() =>
              window.open(`/api/projects/${projectId}/manuscript/compiled/docx`, "_blank")
            }
          >
            <FileDown /> Export full guideline (.docx)
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
