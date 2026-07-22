"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { BookMarked, Download, FolderInput, Plus } from "lucide-react";
import { toast } from "sonner";
import { api, apiDelete, apiPost, ApiError } from "@/lib/api";
import { cn } from "@/lib/utils";
import { PageHeader, StatCard } from "@/components/layout/page-header";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { EmptyState, Skeleton } from "@/components/ui/misc";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { AddReferenceDialog } from "./add-reference-dialog";
import { BibliographyPanel } from "./bibliography-panel";
import { ReferenceRow } from "./reference-row";
import type { ReferenceView, StyleOption } from "./types";

// Mirrors src/server/csl/engine.ts CSL_STYLES (kept in sync manually — 4 entries).
const STYLES: StyleOption[] = [
  { id: "vancouver", label: "Vancouver", numeric: true },
  { id: "ama", label: "AMA (11th ed.)", numeric: true },
  { id: "apa", label: "APA (7th ed.)", numeric: false },
  { id: "nlm", label: "NLM (grant proposals)", numeric: true },
];

const EXPORTS: { format: string; label: string }[] = [
  { format: "ris", label: "RIS (EndNote, Zotero, Mendeley)" },
  { format: "bibtex", label: "BibTeX" },
  { format: "csl-json", label: "CSL-JSON" },
];

interface ProjectFamily {
  isGuideline: boolean;
  parentProject: { id: string; title: string } | null;
}

export function ReferencesClient({ projectId }: { projectId: string }) {
  const [references, setReferences] = useState<ReferenceView[] | null>(null);
  const [family, setFamily] = useState<ProjectFamily | null>(null);
  const [canManage, setCanManage] = useState(false);
  const [search, setSearch] = useState("");
  const [tagFilter, setTagFilter] = useState<string | null>(null);
  const [addOpen, setAddOpen] = useState(false);
  const [editing, setEditing] = useState<ReferenceView | null>(null);
  const [importingStudies, setImportingStudies] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);

  const load = useCallback(() => {
    api<ReferenceView[]>(`/api/projects/${projectId}/references`)
      .then(setReferences)
      .catch((err) => {
        setReferences([]);
        toast.error(err instanceof ApiError ? err.message : "Failed to load references");
      });
  }, [projectId]);

  useEffect(() => {
    load();
    api<{ capabilities: string[] } & ProjectFamily>(`/api/projects/${projectId}`)
      .then((p) => {
        setCanManage(p.capabilities.includes("references.manage"));
        setFamily({ isGuideline: p.isGuideline, parentProject: p.parentProject });
      })
      .catch(() => {
        setCanManage(false);
        setFamily(null);
      });
  }, [projectId, load]);

  function refresh() {
    load();
    setReloadKey((k) => k + 1);
  }

  const allTags = useMemo(() => {
    if (!references) return [];
    const tags = new Set<string>();
    for (const ref of references) for (const tag of ref.tags) tags.add(tag);
    return [...tags].sort();
  }, [references]);

  const visible = useMemo(() => {
    if (!references) return null;
    const needle = search.trim().toLowerCase();
    return references.filter(
      (ref) =>
        (!tagFilter || ref.tags.includes(tagFilter)) &&
        (!needle ||
          ref.title.toLowerCase().includes(needle) ||
          (ref.firstAuthor ?? "").toLowerCase().includes(needle) ||
          (ref.doi ?? "").includes(needle)),
    );
  }, [references, search, tagFilter]);

  async function importIncludedStudies() {
    setImportingStudies(true);
    try {
      const res = await apiPost<{ added: number; skipped: number }>(
        `/api/projects/${projectId}/references/from-citations`,
        {},
      );
      toast.success(
        res.added > 0
          ? `Added ${res.added} included stud${res.added === 1 ? "y" : "ies"} to the library` +
              (res.skipped > 0 ? ` (${res.skipped} already there)` : "")
          : "All included studies are already in the library",
      );
      refresh();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Failed to import included studies");
    } finally {
      setImportingStudies(false);
    }
  }

  async function deleteReference(ref: ReferenceView) {
    if (!window.confirm(`Delete “${ref.title}” from the reference library?`)) return;
    try {
      await apiDelete(`/api/projects/${projectId}/references/${ref.id}`);
      toast.success("Reference deleted");
      refresh();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Failed to delete the reference");
    }
  }

  const stats = references
    ? {
        total: references.length,
        linked: references.filter((r) => r.citationId !== null).length,
        tagged: references.filter((r) => r.tags.length > 0).length,
      }
    : null;

  return (
    <div className="mx-auto w-full max-w-5xl">
      <PageHeader
        title="References"
        description={
          family?.isGuideline
            ? "The guideline's shared citation library — one pool used by the guideline manuscript and every PICO sub-project. Includes references added from any PICO workflow."
            : family?.parentProject
              ? `Shared library of the “${family.parentProject.title}” guideline — references added here are available to the guideline and every PICO question, and vice versa.`
              : "The citation library for your manuscript — methods papers, background references, and included studies. Export it straight into Word reference managers."
        }
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <Popover>
              <PopoverTrigger asChild>
                <Button variant="outline" size="sm">
                  <Download /> Export
                </Button>
              </PopoverTrigger>
              <PopoverContent align="end" className="w-72 p-1.5">
                {EXPORTS.map((e) => (
                  <button
                    key={e.format}
                    type="button"
                    className="block w-full rounded px-2.5 py-1.5 text-left text-sm hover:bg-muted"
                    onClick={() =>
                      window.open(
                        `/api/projects/${projectId}/references/export?format=${e.format}`,
                        "_blank",
                      )
                    }
                  >
                    {e.label}
                  </button>
                ))}
              </PopoverContent>
            </Popover>
            {canManage && (
              <>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={importingStudies}
                  onClick={() => void importIncludedStudies()}
                  title="Mirror every full-text-included citation into the library"
                >
                  <FolderInput /> Import included studies
                </Button>
                <Button
                  size="sm"
                  onClick={() => {
                    setEditing(null);
                    setAddOpen(true);
                  }}
                >
                  <Plus /> Add reference
                </Button>
              </>
            )}
          </div>
        }
      />

      {stats ? (
        <div className="grid gap-4 sm:grid-cols-3">
          <StatCard label="References" value={stats.total} />
          <StatCard label="Included studies" value={stats.linked} hint="Mirrored from screening" />
          <StatCard label="Tagged" value={stats.tagged} />
        </div>
      ) : (
        <div className="grid gap-4 sm:grid-cols-3">
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} className="h-24" />
          ))}
        </div>
      )}

      <div className="mt-6 flex flex-wrap items-center gap-x-4 gap-y-2">
        <Input
          placeholder="Search title, author, or DOI…"
          className="max-w-xs"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        {allTags.length > 0 && (
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="text-xs font-medium text-muted-foreground">Tags:</span>
            <TagChip active={tagFilter === null} onClick={() => setTagFilter(null)}>
              All
            </TagChip>
            {allTags.map((tag) => (
              <TagChip
                key={tag}
                active={tagFilter === tag}
                onClick={() => setTagFilter(tagFilter === tag ? null : tag)}
              >
                {tag}
              </TagChip>
            ))}
          </div>
        )}
      </div>

      <div className="mt-6 space-y-3">
        {visible === null ? (
          [0, 1, 2].map((i) => <Skeleton key={i} className="h-28" />)
        ) : references !== null && references.length === 0 ? (
          <EmptyState
            icon={BookMarked}
            title="No references yet"
            description={
              canManage
                ? "Add methods papers and background references by DOI/PMID, import an RIS/BibTeX file, or mirror your included studies."
                : "References added by the team will appear here."
            }
          />
        ) : visible.length === 0 ? (
          <EmptyState
            icon={BookMarked}
            title="No references match the current filters"
            description="Adjust the search or tag filters to see more of the library."
          />
        ) : (
          visible.map((ref) => (
            <ReferenceRow
              key={ref.id}
              reference={ref}
              canManage={canManage}
              onEdit={() => {
                setEditing(ref);
                setAddOpen(true);
              }}
              onDelete={() => void deleteReference(ref)}
            />
          ))
        )}
      </div>

      {references !== null && references.length > 0 && (
        <div className="mt-8">
          <BibliographyPanel projectId={projectId} styles={STYLES} reloadKey={reloadKey} />
        </div>
      )}

      <AddReferenceDialog
        projectId={projectId}
        open={addOpen}
        onOpenChange={(open) => {
          setAddOpen(open);
          if (!open) setEditing(null);
        }}
        onSaved={refresh}
        editing={editing}
      />
    </div>
  );
}

function TagChip({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "rounded-full border px-2.5 py-1 text-xs font-medium transition-colors",
        active
          ? "border-transparent bg-primary text-primary-foreground"
          : "border-border bg-background text-muted-foreground hover:bg-muted",
      )}
    >
      {children}
    </button>
  );
}
