"use client";

// Extract tab: studies list (with quantitative-synthesis toggle), existing forms per study
// (blind-filtered server-side — extractors only see their own), start/resume extraction,
// and admin assignment of extractors. Opening a form swaps in the FormWorkspace.

import { useCallback, useEffect, useState } from "react";
import { FileSpreadsheet, FlaskConical, Plus, UserPlus } from "lucide-react";
import { toast } from "sonner";
import { api, apiPatch, apiPost, ApiError } from "@/lib/api";
import { formatAuthors } from "@/components/citations/citation-card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Alert, EmptyState, Skeleton, Spinner } from "@/components/ui/misc";
import { Select } from "@/components/ui/select";
import { FormWorkspace } from "./form-workspace";
import { FormStatusBadge } from "./status-badges";
import {
  hasCap,
  type ExtractionFormData,
  type MyAssignment,
  type ProjectAiStatus,
  type Study,
  type Template,
} from "./types";

interface MemberRow {
  id: string;
  status: string;
  roles: string[];
  user: { id: string; name: string; email: string };
}

export function ExtractTab({
  projectId,
  templates,
  meId,
  roles,
  ai,
}: {
  projectId: string;
  templates: Template[] | null;
  meId: string | null;
  roles: string[] | null;
  ai: ProjectAiStatus | null;
}) {
  const [studies, setStudies] = useState<Study[] | null>(null);
  const [forms, setForms] = useState<ExtractionFormData[] | null>(null);
  const [myAssignments, setMyAssignments] = useState<MyAssignment[] | null>(null);
  const [workspaceForm, setWorkspaceForm] = useState<ExtractionFormData | null>(null);

  // Start-extraction dialog
  const [startStudy, setStartStudy] = useState<Study | null>(null);
  const [startTemplateId, setStartTemplateId] = useState("");
  const [startBusy, setStartBusy] = useState(false);

  // Assign dialog (project.edit only)
  const [assignStudy, setAssignStudy] = useState<Study | null>(null);
  const [members, setMembers] = useState<MemberRow[] | null>(null);
  const [assignTemplateId, setAssignTemplateId] = useState("");
  const [assignChecked, setAssignChecked] = useState<string[]>([]);
  const [assignBusy, setAssignBusy] = useState(false);

  const load = useCallback(() => {
    api<Study[]>(`/api/projects/${projectId}/studies`)
      .then(setStudies)
      .catch(() => {
        setStudies([]);
        toast.error("Failed to load studies");
      });
    api<ExtractionFormData[]>(`/api/projects/${projectId}/extraction-forms`)
      .then(setForms)
      .catch(() => setForms([]));
    api<MyAssignment[]>(`/api/projects/${projectId}/extraction/assignments?mine=true`)
      .then(setMyAssignments)
      .catch(() => setMyAssignments([]));
  }, [projectId]);

  useEffect(load, [load]);

  const publishedTemplates = (templates ?? []).filter((t) => t.status === "PUBLISHED");
  const canPerform = hasCap(roles, "extraction.perform");
  const canProjectEdit = hasCap(roles, "project.edit");

  async function toggleQuantSynthesis(study: Study, next: boolean) {
    setStudies((prev) =>
      prev?.map((s) => (s.id === study.id ? { ...s, inQuantitativeSynthesis: next } : s)) ?? prev,
    );
    try {
      await apiPatch(`/api/projects/${projectId}/studies/${study.id}`, {
        inQuantitativeSynthesis: next,
      });
      toast.success(
        next
          ? `${study.label} included in quantitative synthesis`
          : `${study.label} removed from quantitative synthesis`,
      );
    } catch (err) {
      setStudies((prev) =>
        prev?.map((s) => (s.id === study.id ? { ...s, inQuantitativeSynthesis: !next } : s)) ??
          prev,
      );
      toast.error(err instanceof ApiError ? err.message : "Failed to update study");
    }
  }

  function openStart(study: Study) {
    setStartStudy(study);
    setStartTemplateId(publishedTemplates[0]?.id ?? "");
  }

  async function startExtraction(e: React.FormEvent) {
    e.preventDefault();
    if (!startStudy || startTemplateId === "") return;
    setStartBusy(true);
    try {
      const primary =
        startStudy.reportLinks.find((l) => l.isPrimaryReport) ?? startStudy.reportLinks[0];
      const form = await apiPost<ExtractionFormData>(
        `/api/projects/${projectId}/studies/${startStudy.id}/extraction-forms`,
        {
          templateId: startTemplateId,
          ...(primary ? { citationId: primary.citationId } : {}),
        },
      );
      toast.success("Extraction form ready");
      setStartStudy(null);
      setWorkspaceForm(form);
    } catch (err) {
      // e.g. "You are not assigned to extract this study" (R15)
      toast.error(err instanceof ApiError ? err.message : "Failed to start extraction");
    } finally {
      setStartBusy(false);
    }
  }

  function openAssign(study: Study) {
    setAssignStudy(study);
    setAssignTemplateId(publishedTemplates[0]?.id ?? "");
    setAssignChecked([]);
    if (members === null) {
      api<MemberRow[]>(`/api/projects/${projectId}/members`)
        .then(setMembers)
        .catch(() => setMembers([]));
    }
  }

  async function submitAssign(e: React.FormEvent) {
    e.preventDefault();
    if (!assignStudy || assignTemplateId === "" || assignChecked.length === 0) return;
    setAssignBusy(true);
    try {
      const res = await apiPost<{ created: { id: string }[]; skipped: number }>(
        `/api/projects/${projectId}/extraction/assignments`,
        { templateId: assignTemplateId, studyIds: [assignStudy.id], extractorIds: assignChecked },
      );
      toast.success(
        `${res.created.length} assignment${res.created.length === 1 ? "" : "s"} created` +
          (res.skipped > 0 ? ` (${res.skipped} already existed)` : ""),
      );
      setAssignStudy(null);
      load();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Failed to create assignments");
    } finally {
      setAssignBusy(false);
    }
  }

  if (workspaceForm) {
    return (
      <FormWorkspace
        projectId={projectId}
        initialForm={workspaceForm}
        meId={meId}
        canSeeConflicts={hasCap(roles, "extraction.adjudicate")}
        ai={ai}
        onClose={() => {
          setWorkspaceForm(null);
          load();
        }}
      />
    );
  }

  const eligibleMembers = (members ?? []).filter(
    (m) => m.status === "ACTIVE" && hasCap(m.roles, "extraction.perform"),
  );

  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">
        Studies are the unit of analysis — created when a report is included at full-text
        screening. Start an extraction form to record data against a published template.
      </p>

      {studies === null ? (
        <div className="space-y-3">
          <Skeleton className="h-28" />
          <Skeleton className="h-28" />
          <Skeleton className="h-28" />
        </div>
      ) : studies.length === 0 ? (
        <EmptyState
          icon={FlaskConical}
          title="No studies yet"
          description="Studies appear automatically once citations are included at full-text screening."
        />
      ) : (
        <div className="space-y-3">
          {studies.map((s) => {
            const primary = s.reportLinks.find((l) => l.isPrimaryReport) ?? s.reportLinks[0];
            const extraReports = s.reportLinks.length - 1;
            const studyForms = (forms ?? []).filter((f) => f.studyId === s.id);
            const assignedTemplates = (myAssignments ?? []).filter((a) => a.studyId === s.id);
            return (
              <Card key={s.id}>
                <CardContent className="p-5">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <h3 className="font-semibold">{s.label}</h3>
                        {assignedTemplates.map((a) => (
                          <Badge key={a.id} variant="maybe">
                            Assigned to you · {a.template.name} v{a.template.version}
                          </Badge>
                        ))}
                      </div>
                      {primary ? (
                        <>
                          <p
                            className="mt-1 line-clamp-1 text-sm text-muted-foreground"
                            title={primary.citation.title}
                          >
                            {primary.citation.title}
                          </p>
                          <p className="mt-0.5 text-xs text-muted-foreground">
                            {[
                              formatAuthors(primary.citation.authors, 3),
                              primary.citation.year ? String(primary.citation.year) : null,
                              primary.citation.journal,
                            ]
                              .filter(Boolean)
                              .join(" · ")}
                            {extraReports > 0
                              ? ` · +${extraReports} more report${extraReports === 1 ? "" : "s"}`
                              : ""}
                          </p>
                        </>
                      ) : (
                        <p className="mt-1 text-sm italic text-muted-foreground">
                          No linked report.
                        </p>
                      )}
                    </div>
                    <div className="flex flex-wrap items-center gap-2">
                      <label
                        title="Include in quantitative synthesis (meta-analysis)"
                        className="flex cursor-pointer items-center gap-1.5 text-xs text-muted-foreground"
                      >
                        <input
                          type="checkbox"
                          className="h-4 w-4 rounded border-input accent-primary disabled:cursor-not-allowed"
                          checked={s.inQuantitativeSynthesis}
                          disabled={!canProjectEdit}
                          onChange={(e) => toggleQuantSynthesis(s, e.target.checked)}
                        />
                        Quant. synthesis
                      </label>
                      {canProjectEdit && (
                        <Button variant="ghost" size="sm" onClick={() => openAssign(s)}>
                          <UserPlus /> Assign
                        </Button>
                      )}
                      {canPerform && (
                        <Button variant="outline" size="sm" onClick={() => openStart(s)}>
                          <Plus /> Start extraction
                        </Button>
                      )}
                    </div>
                  </div>
                  {forms === null ? (
                    <Skeleton className="mt-3 h-8" />
                  ) : (
                    studyForms.length > 0 && (
                      <div className="mt-3 flex flex-wrap gap-2 border-t border-border pt-3">
                        {studyForms.map((f) => (
                          <button
                            key={f.id}
                            type="button"
                            onClick={() => setWorkspaceForm(f)}
                            className="flex items-center gap-2 rounded-md border border-border bg-background px-2.5 py-1.5 text-xs transition-colors hover:bg-muted"
                          >
                            <FileSpreadsheet className="h-3.5 w-3.5 text-muted-foreground" />
                            <span className="font-medium">
                              {f.template.name} v{f.template.version}
                            </span>
                            <span className="text-muted-foreground">
                              {f.extractor.name}
                              {meId !== null && f.extractorId === meId ? " (you)" : ""}
                            </span>
                            <FormStatusBadge status={f.status} />
                          </button>
                        ))}
                      </div>
                    )
                  )}
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}

      {/* Start extraction dialog */}
      <Dialog open={startStudy !== null} onOpenChange={(o) => !o && setStartStudy(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Start extraction{startStudy ? ` — ${startStudy.label}` : ""}</DialogTitle>
            <DialogDescription>
              Pick a published template. If you already started a form with it, that form is
              resumed.
            </DialogDescription>
          </DialogHeader>
          {publishedTemplates.length === 0 ? (
            <Alert variant="warning">
              No published template yet — publish one in the Templates tab first.
            </Alert>
          ) : (
            <form onSubmit={startExtraction} className="space-y-4">
              <div className="space-y-1.5">
                <Label htmlFor="start-template">Template</Label>
                <Select
                  id="start-template"
                  value={startTemplateId}
                  onChange={(e) => setStartTemplateId(e.target.value)}
                >
                  {publishedTemplates.map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.name} (v{t.version})
                    </option>
                  ))}
                </Select>
              </div>
              <DialogFooter>
                <Button type="submit" disabled={startBusy || startTemplateId === ""}>
                  {startBusy && <Spinner />} Start
                </Button>
              </DialogFooter>
            </form>
          )}
        </DialogContent>
      </Dialog>

      {/* Assign extractors dialog */}
      <Dialog open={assignStudy !== null} onOpenChange={(o) => !o && setAssignStudy(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              Assign extractors{assignStudy ? ` — ${assignStudy.label}` : ""}
            </DialogTitle>
            <DialogDescription>
              Assigned extractors can start a form for this study. Dual extraction (two
              extractors) enables conflict detection.
            </DialogDescription>
          </DialogHeader>
          {publishedTemplates.length === 0 ? (
            <Alert variant="warning">
              Assignments need a published template — publish one in the Templates tab first.
            </Alert>
          ) : (
            <form onSubmit={submitAssign} className="space-y-4">
              <div className="space-y-1.5">
                <Label htmlFor="assign-template">Template</Label>
                <Select
                  id="assign-template"
                  value={assignTemplateId}
                  onChange={(e) => setAssignTemplateId(e.target.value)}
                >
                  {publishedTemplates.map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.name} (v{t.version})
                    </option>
                  ))}
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label>Extractors</Label>
                {members === null ? (
                  <Skeleton className="h-20" />
                ) : eligibleMembers.length === 0 ? (
                  <p className="text-sm text-muted-foreground">
                    No active members with extraction access.
                  </p>
                ) : (
                  <div className="max-h-48 space-y-1.5 overflow-y-auto rounded-md border border-border p-3">
                    {eligibleMembers.map((m) => {
                      const checked = assignChecked.includes(m.user.id);
                      return (
                        <label
                          key={m.id}
                          className="flex cursor-pointer items-center gap-2 text-sm"
                        >
                          <input
                            type="checkbox"
                            className="h-4 w-4 rounded border-input accent-primary"
                            checked={checked}
                            onChange={() =>
                              setAssignChecked((prev) =>
                                checked
                                  ? prev.filter((id) => id !== m.user.id)
                                  : [...prev, m.user.id],
                              )
                            }
                          />
                          <span>{m.user.name}</span>
                          <span className="text-xs text-muted-foreground">{m.user.email}</span>
                        </label>
                      );
                    })}
                  </div>
                )}
              </div>
              <DialogFooter>
                <Button
                  type="submit"
                  disabled={assignBusy || assignChecked.length === 0 || assignTemplateId === ""}
                >
                  {assignBusy && <Spinner />} Assign
                </Button>
              </DialogFooter>
            </form>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
