"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useSearchParams } from "next/navigation";
import { FileDown } from "lucide-react";
import { toast } from "sonner";
import { api, apiPatch, ApiError } from "@/lib/api";
import type { CiteMapLike } from "@/lib/manuscript/cite-format";
import { PageHeader } from "@/components/layout/page-header";
import { Button } from "@/components/ui/button";
import { Select } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/misc";
import { CiteMapContext } from "./cite-map-context";
import { CommentsPanel } from "./comments-panel";
import { GuidelineCompileDialog } from "./guideline-compile-dialog";
import { SectionEditor } from "./section-editor";
import { SectionList } from "./section-list";
import type { CiteMapResponse, ManuscriptView, MemberRef, UserRef } from "./types";

const POLL_MS = 10_000;

// Mirrors src/server/csl/engine.ts CSL_STYLES.
const STYLES = [
  { id: "vancouver", label: "Vancouver" },
  { id: "ama", label: "AMA (11th ed.)" },
  { id: "apa", label: "APA (7th ed.)" },
  { id: "nlm", label: "NLM (grant proposals)" },
];

interface ProjectFamily {
  isGuideline: boolean;
  parentProject: { id: string; title: string } | null;
}

export function ManuscriptClient({ projectId }: { projectId: string }) {
  const searchParams = useSearchParams();
  const [manuscript, setManuscript] = useState<ManuscriptView | null>(null);
  const [family, setFamily] = useState<ProjectFamily | null>(null);
  const [me, setMe] = useState<UserRef | null>(null);
  const [members, setMembers] = useState<MemberRef[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(searchParams.get("section"));
  const [citeMap, setCiteMap] = useState<CiteMapResponse | null>(null);

  const load = useCallback(async () => {
    try {
      const data = await api<ManuscriptView>(`/api/projects/${projectId}/manuscript`);
      setManuscript(data);
      setSelectedId((prev) => prev ?? data.sections[0]?.id ?? null);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Failed to load the manuscript");
    }
  }, [projectId]);

  const loadCiteMap = useCallback(() => {
    api<CiteMapResponse>(`/api/projects/${projectId}/manuscript/cite-map`)
      .then(setCiteMap)
      .catch(() => setCiteMap(null));
  }, [projectId]);

  useEffect(() => {
    load();
    loadCiteMap();
    api<{ user: UserRef }>(`/api/me`)
      .then((res) => setMe({ id: res.user.id, name: res.user.name }))
      .catch(() => setMe(null));
    api<MemberRef[]>(`/api/projects/${projectId}/members`)
      .then(setMembers)
      .catch(() => setMembers([]));
    api<ProjectFamily>(`/api/projects/${projectId}`)
      .then(setFamily)
      .catch(() => setFamily(null));
  }, [projectId, load, loadCiteMap]);

  // Presence/status polling (visible only + focus refetch — app convention).
  useEffect(() => {
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") load();
    }, POLL_MS);
    const onFocus = () => load();
    window.addEventListener("focus", onFocus);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("focus", onFocus);
    };
  }, [load]);

  const citeMapLike: CiteMapLike | null = useMemo(
    () => (citeMap ? { numeric: citeMap.numeric, markers: citeMap.markers } : null),
    [citeMap],
  );

  async function changeStyle(styleId: string) {
    try {
      await apiPatch(`/api/projects/${projectId}/manuscript`, { citationStyleId: styleId });
      loadCiteMap();
      load();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Failed to change the citation style");
    }
  }

  if (!manuscript) {
    return (
      <div className="mx-auto w-full max-w-6xl">
        <PageHeader title="Manuscript" />
        <Skeleton className="h-96" />
      </div>
    );
  }

  return (
    <CiteMapContext.Provider value={citeMapLike}>
      <div className="mx-auto flex w-full max-w-6xl flex-col">
        <PageHeader
          title="Manuscript"
          description={
            family?.isGuideline
              ? "The guideline's general sections — introduction, methods, conclusions. Each PICO question's sections are drafted in its sub-project and come together in the compiled guideline."
              : family?.parentProject
                ? `Sections for this PICO question — they compile into the “${family.parentProject.title}” guideline document alongside the other questions.`
                : "Draft the paper section by section — different members can work on different sections at once."
          }
          actions={
            <div className="flex flex-wrap items-center gap-2">
              {family?.isGuideline && <GuidelineCompileDialog projectId={projectId} />}
              {manuscript.canManage && (
                <Select
                  aria-label="Citation style"
                  className="h-8 w-44 text-xs"
                  value={citeMap?.styleId ?? manuscript.citationStyleId ?? "vancouver"}
                  onChange={(e) => void changeStyle(e.target.value)}
                >
                  {STYLES.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.label}
                    </option>
                  ))}
                </Select>
              )}
              <Button
                variant="outline"
                size="sm"
                onClick={() =>
                  window.open(`/api/projects/${projectId}/manuscript/export/docx`, "_blank")
                }
              >
                <FileDown /> Export DOCX
              </Button>
            </div>
          }
        />
        <div className="grid min-h-[70vh] gap-4 lg:grid-cols-[14rem_minmax(0,1fr)_18rem]">
          <div className="rounded-lg border border-border bg-card p-3">
            <SectionList
              projectId={projectId}
              sections={manuscript.sections}
              selectedId={selectedId}
              onSelect={setSelectedId}
              canManage={manuscript.canManage}
              onChanged={load}
            />
          </div>
          <div className="rounded-lg border border-border bg-card p-4">
            {selectedId ? (
              <SectionEditor
                key={selectedId}
                projectId={projectId}
                sectionId={selectedId}
                me={me}
                members={members}
                canManage={manuscript.canManage}
                onChanged={load}
                onCitationsChanged={loadCiteMap}
              />
            ) : (
              <p className="text-sm text-muted-foreground">Select a section to start.</p>
            )}
          </div>
          <div className="rounded-lg border border-border bg-card p-3">
            {selectedId && (
              <CommentsPanel
                projectId={projectId}
                sectionId={selectedId}
                me={me}
                members={members}
                canComment={manuscript.canComment}
                canManage={manuscript.canManage}
              />
            )}
          </div>
        </div>

        {citeMap && citeMap.bibliography.length > 0 && (
          <div className="mt-4 rounded-lg border border-border bg-card p-4">
            <h3 className="text-sm font-semibold">References (auto-generated)</h3>
            <p className="mt-0.5 text-xs text-muted-foreground">
              Built from the citations used above, in order of first use — included in the DOCX
              export automatically.
            </p>
            <ol className="mt-2 space-y-1.5 text-sm leading-relaxed">
              {citeMap.bibliography.map((entry) => (
                <li key={entry.referenceId} className="flex gap-2">
                  {citeMap.numeric && (
                    <span className="shrink-0 tabular-nums text-muted-foreground">
                      {entry.index}.
                    </span>
                  )}
                  <span dangerouslySetInnerHTML={{ __html: entry.html }} />
                </li>
              ))}
            </ol>
          </div>
        )}
      </div>
    </CiteMapContext.Provider>
  );
}
