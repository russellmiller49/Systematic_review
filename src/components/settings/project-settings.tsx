"use client";

import { useEffect, useState } from "react";
import { toast } from "sonner";
import { apiPatch, ApiError } from "@/lib/api";
import { formatDate } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { Alert, Skeleton, Spinner } from "@/components/ui/misc";
import type { ProjectDetail, ScreeningStageRow } from "./types";

const REVIEW_TYPES: { value: string; label: string }[] = [
  { value: "SYSTEMATIC_REVIEW", label: "Systematic review" },
  { value: "SYSTEMATIC_REVIEW_META_ANALYSIS", label: "SR + meta-analysis" },
  { value: "DIAGNOSTIC_TEST_ACCURACY", label: "Diagnostic test accuracy" },
  { value: "SCOPING_REVIEW", label: "Scoping review" },
  { value: "RAPID_REVIEW", label: "Rapid review" },
  { value: "LIVING_SYSTEMATIC_REVIEW", label: "Living systematic review" },
  { value: "GUIDELINE_EVIDENCE_REVIEW", label: "Guideline evidence review" },
];

const PROJECT_STATUSES: { value: string; label: string }[] = [
  { value: "PLANNING", label: "Planning" },
  { value: "SCREENING", label: "Screening" },
  { value: "EXTRACTION", label: "Extraction" },
  { value: "ANALYSIS", label: "Analysis" },
  { value: "COMPLETED", label: "Completed" },
  { value: "ARCHIVED", label: "Archived" },
];

const STAGE_LABELS: Record<ScreeningStageRow["type"], string> = {
  TITLE_ABSTRACT: "Title & abstract",
  FULL_TEXT: "Full text",
};

const STAGE_ORDER: Record<ScreeningStageRow["type"], number> = {
  TITLE_ABSTRACT: 0,
  FULL_TEXT: 1,
};

interface DetailsForm {
  title: string;
  reviewType: string;
  status: string;
  researchQuestion: string;
  description: string;
  registrationPlatform: string;
  registrationId: string;
}

interface StageEdit {
  reviewersPerCitation: number;
  blinded: boolean;
  maybeGeneratesConflict: boolean;
}

export function ProjectSettingsSection({
  projectId,
  project,
  canEdit,
  onSaved,
}: {
  projectId: string;
  project: ProjectDetail | null;
  canEdit: boolean;
  onSaved: () => void;
}) {
  const [form, setForm] = useState<DetailsForm>({
    title: "",
    reviewType: "SYSTEMATIC_REVIEW",
    status: "PLANNING",
    researchQuestion: "",
    description: "",
    registrationPlatform: "",
    registrationId: "",
  });
  const [savingDetails, setSavingDetails] = useState(false);
  const [stageEdits, setStageEdits] = useState<Record<string, StageEdit>>({});
  const [savingStageId, setSavingStageId] = useState<string | null>(null);

  useEffect(() => {
    if (!project) return;
    setForm({
      title: project.title,
      reviewType: project.reviewType,
      status: project.status,
      researchQuestion: project.researchQuestion ?? "",
      description: project.description ?? "",
      registrationPlatform: project.registrationPlatform ?? "",
      registrationId: project.registrationId ?? "",
    });
    const edits: Record<string, StageEdit> = {};
    for (const stage of project.screeningStages) {
      edits[stage.id] = {
        reviewersPerCitation: stage.reviewersPerCitation,
        blinded: stage.blinded,
        maybeGeneratesConflict: stage.maybeGeneratesConflict,
      };
    }
    setStageEdits(edits);
  }, [project]);

  async function saveDetails(e: React.FormEvent) {
    e.preventDefault();
    setSavingDetails(true);
    try {
      await apiPatch(`/api/projects/${projectId}`, {
        title: form.title.trim(),
        reviewType: form.reviewType,
        status: form.status,
        researchQuestion: form.researchQuestion.trim() || null,
        description: form.description.trim() || null,
        registrationPlatform: form.registrationPlatform.trim() || null,
        registrationId: form.registrationId.trim() || null,
      });
      toast.success("Project updated");
      onSaved();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Failed to update project");
    } finally {
      setSavingDetails(false);
    }
  }

  async function saveStage(stage: ScreeningStageRow) {
    const edit = stageEdits[stage.id];
    if (!edit) return;
    setSavingStageId(stage.id);
    try {
      await apiPatch(`/api/projects/${projectId}/screening/stages/${stage.id}`, edit);
      toast.success(`${STAGE_LABELS[stage.type]} stage updated`);
      onSaved();
    } catch (err) {
      toast.error(
        err instanceof ApiError ? err.message : "Failed to update screening stage",
      );
    } finally {
      setSavingStageId(null);
    }
  }

  const stages = project
    ? [...project.screeningStages].sort((a, b) => STAGE_ORDER[a.type] - STAGE_ORDER[b.type])
    : [];

  return (
    <section className="space-y-3">
      <h2 className="text-lg font-medium">Project</h2>
      {!project ? (
        <Skeleton className="h-96" />
      ) : (
        <div className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Details</CardTitle>
              <CardDescription>
                {canEdit
                  ? "Title, review type, status, and registration."
                  : "Only project owners and admins can edit these settings."}
              </CardDescription>
            </CardHeader>
            <CardContent>
              <form onSubmit={saveDetails} className="space-y-4">
                <div className="space-y-1.5">
                  <Label htmlFor="p-title">Title</Label>
                  <Input
                    id="p-title"
                    required
                    minLength={2}
                    maxLength={300}
                    disabled={!canEdit}
                    value={form.title}
                    onChange={(e) => setForm((f) => ({ ...f, title: e.target.value }))}
                  />
                </div>
                <div className="grid gap-4 sm:grid-cols-2">
                  <div className="space-y-1.5">
                    <Label htmlFor="p-review-type">Review type</Label>
                    <Select
                      id="p-review-type"
                      disabled={!canEdit}
                      value={form.reviewType}
                      onChange={(e) => setForm((f) => ({ ...f, reviewType: e.target.value }))}
                    >
                      {REVIEW_TYPES.map((t) => (
                        <option key={t.value} value={t.value}>
                          {t.label}
                        </option>
                      ))}
                    </Select>
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor="p-status">Status</Label>
                    <Select
                      id="p-status"
                      disabled={!canEdit}
                      value={form.status}
                      onChange={(e) => setForm((f) => ({ ...f, status: e.target.value }))}
                    >
                      {PROJECT_STATUSES.map((s) => (
                        <option key={s.value} value={s.value}>
                          {s.label}
                        </option>
                      ))}
                    </Select>
                  </div>
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="p-question">Research question</Label>
                  <Textarea
                    id="p-question"
                    maxLength={2000}
                    disabled={!canEdit}
                    value={form.researchQuestion}
                    onChange={(e) =>
                      setForm((f) => ({ ...f, researchQuestion: e.target.value }))
                    }
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="p-description">Description</Label>
                  <Textarea
                    id="p-description"
                    maxLength={5000}
                    disabled={!canEdit}
                    value={form.description}
                    onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))}
                  />
                </div>
                <div className="grid gap-4 sm:grid-cols-2">
                  <div className="space-y-1.5">
                    <Label htmlFor="p-reg-platform">Registration platform</Label>
                    <Input
                      id="p-reg-platform"
                      placeholder="e.g. PROSPERO"
                      maxLength={120}
                      disabled={!canEdit}
                      value={form.registrationPlatform}
                      onChange={(e) =>
                        setForm((f) => ({ ...f, registrationPlatform: e.target.value }))
                      }
                    />
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor="p-reg-id">Registration ID</Label>
                    <Input
                      id="p-reg-id"
                      maxLength={120}
                      disabled={!canEdit}
                      value={form.registrationId}
                      onChange={(e) =>
                        setForm((f) => ({ ...f, registrationId: e.target.value }))
                      }
                    />
                  </div>
                </div>
                {canEdit && (
                  <div className="flex justify-end">
                    <Button type="submit" disabled={savingDetails}>
                      {savingDetails && <Spinner />} Save changes
                    </Button>
                  </div>
                )}
              </form>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-base">Screening configuration</CardTitle>
              <CardDescription>
                Per-stage reviewer count, blinding, and conflict behavior.
                {!canEdit && " Only project owners and admins can change these."}
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              {stages.map((stage) => {
                const edit = stageEdits[stage.id];
                if (!edit) return null;
                const dirty =
                  edit.reviewersPerCitation !== stage.reviewersPerCitation ||
                  edit.blinded !== stage.blinded ||
                  edit.maybeGeneratesConflict !== stage.maybeGeneratesConflict;
                const unblinding = stage.blinded && !edit.blinded;
                return (
                  <div key={stage.id} className="rounded-lg border border-border p-4">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <p className="font-medium">{STAGE_LABELS[stage.type]}</p>
                      {stage.unblindedAt && (
                        <Badge variant="maybe">
                          unblinded {formatDate(stage.unblindedAt)}
                        </Badge>
                      )}
                    </div>
                    <div className="mt-3 grid gap-4 sm:grid-cols-2">
                      <div className="space-y-1.5">
                        <Label htmlFor={`rpc-${stage.id}`}>Reviewers per citation</Label>
                        <Select
                          id={`rpc-${stage.id}`}
                          disabled={!canEdit}
                          value={String(edit.reviewersPerCitation)}
                          onChange={(e) =>
                            setStageEdits((prev) => ({
                              ...prev,
                              [stage.id]: {
                                ...edit,
                                reviewersPerCitation: Number(e.target.value),
                              },
                            }))
                          }
                        >
                          <option value="1">1 (single screening)</option>
                          <option value="2">2 (dual screening)</option>
                          <option value="3">3</option>
                        </Select>
                      </div>
                      <div className="space-y-2 sm:pt-7">
                        <label className="flex items-center gap-2 text-sm">
                          <input
                            type="checkbox"
                            className="h-4 w-4 accent-primary"
                            disabled={!canEdit}
                            checked={edit.blinded}
                            onChange={(e) =>
                              setStageEdits((prev) => ({
                                ...prev,
                                [stage.id]: { ...edit, blinded: e.target.checked },
                              }))
                            }
                          />
                          Blinded — reviewers can&apos;t see each other&apos;s decisions
                        </label>
                        <label className="flex items-center gap-2 text-sm">
                          <input
                            type="checkbox"
                            className="h-4 w-4 accent-primary"
                            disabled={!canEdit}
                            checked={edit.maybeGeneratesConflict}
                            onChange={(e) =>
                              setStageEdits((prev) => ({
                                ...prev,
                                [stage.id]: {
                                  ...edit,
                                  maybeGeneratesConflict: e.target.checked,
                                },
                              }))
                            }
                          />
                          &ldquo;Maybe&rdquo; votes open conflicts
                        </label>
                      </div>
                    </div>
                    {unblinding && (
                      <Alert variant="warning" className="mt-3">
                        Unblinding reveals reviewers&apos; decisions to each other and is
                        recorded permanently in the audit trail.
                      </Alert>
                    )}
                    {canEdit && (
                      <div className="mt-3 flex justify-end">
                        <Button
                          size="sm"
                          disabled={!dirty || savingStageId === stage.id}
                          onClick={() => saveStage(stage)}
                        >
                          {savingStageId === stage.id && <Spinner />} Save stage
                        </Button>
                      </div>
                    )}
                  </div>
                );
              })}
            </CardContent>
          </Card>
        </div>
      )}
    </section>
  );
}
