"use client";

// Extraction form workspace: dynamic field rendering with per-field autosave
// (PUT /extraction-forms/[formId]/values/[fieldId]) and completion.
//
// Editability rules (mirroring the service, never inferring hidden data):
//   - only the form's extractor can edit (admins get read-only here too);
//   - IN_PROGRESS forms are fully editable;
//   - COMPLETED forms are read-only EXCEPT fields with an OPEN conflict (the pre-adjudication
//     convergence path). Adjudicators/admins can list conflicts, so for them disputed fields
//     unlock automatically; extractors cannot list conflicts (blinding), so they get a
//     per-field "Edit" affordance and the server decides — its message is surfaced on refusal.
//   - a field whose conflict was RESOLVED (adjudicated) is permanently locked.

import { Fragment, useCallback, useEffect, useState } from "react";
import { ArrowLeft, Check, CircleAlert, Lock, Pencil } from "lucide-react";
import { toast } from "sonner";
import { api, apiPost, apiPut, ApiError } from "@/lib/api";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Alert, Progress, Skeleton, Spinner } from "@/components/ui/misc";
import { FieldValueEditor } from "./field-value-editor";
import { FormStatusBadge } from "./status-badges";
import {
  formatFieldValue,
  type ExtractionFormData,
  type FormStatus,
  type FormValue,
  type Template,
  type TemplateField,
} from "./types";

interface SaveState {
  status: "saving" | "saved" | "error";
  message?: string;
}

interface ConflictSlice {
  studyId: string;
  templateId: string;
  fieldId: string;
  status: "OPEN" | "RESOLVED" | "VOIDED";
}

function SaveIndicator({ state }: { state: SaveState | undefined }) {
  if (!state) return null;
  if (state.status === "saving") return <Spinner className="h-3.5 w-3.5 text-muted-foreground" />;
  if (state.status === "saved") {
    return (
      <span className="flex items-center gap-1 text-xs text-include">
        <Check className="h-3.5 w-3.5" /> Saved
      </span>
    );
  }
  return (
    <span className="flex items-center gap-1 text-xs text-exclude">
      <CircleAlert className="h-3.5 w-3.5" /> {state.message ?? "Failed to save"}
    </span>
  );
}

export function FormWorkspace({
  projectId,
  initialForm,
  meId,
  canSeeConflicts,
  onClose,
}: {
  projectId: string;
  initialForm: ExtractionFormData;
  meId: string | null;
  canSeeConflicts: boolean;
  onClose: () => void;
}) {
  const [form, setForm] = useState(initialForm);
  const [template, setTemplate] = useState<Template | null>(null);
  const [values, setValues] = useState<Record<string, FormValue>>(() =>
    Object.fromEntries(initialForm.values.map((v) => [v.fieldId, v])),
  );
  const [saveStates, setSaveStates] = useState<Record<string, SaveState>>({});
  // null = unknown (viewer may not list conflicts — blinded); otherwise precise sets.
  const [conflictInfo, setConflictInfo] = useState<{
    open: Set<string>;
    resolved: Set<string>;
  } | null>(null);
  const [unlockedFields, setUnlockedFields] = useState<Set<string>>(new Set());
  const [missingKeys, setMissingKeys] = useState<Set<string>>(new Set());
  const [completing, setCompleting] = useState(false);

  const isMine = meId !== null && form.extractorId === meId;

  useEffect(() => {
    api<Template>(`/api/projects/${projectId}/extraction/templates/${form.templateId}`)
      .then(setTemplate)
      .catch(() => toast.error("Failed to load template fields"));
  }, [projectId, form.templateId]);

  const loadConflicts = useCallback(() => {
    if (!canSeeConflicts) return;
    api<ConflictSlice[]>(`/api/projects/${projectId}/extraction/conflicts`)
      .then((rows) => {
        const open = new Set<string>();
        const resolved = new Set<string>();
        for (const c of rows) {
          if (c.studyId !== form.studyId || c.templateId !== form.templateId) continue;
          if (c.status === "OPEN") open.add(c.fieldId);
          else if (c.status === "RESOLVED") resolved.add(c.fieldId);
        }
        setConflictInfo({ open, resolved });
      })
      .catch(() => setConflictInfo(null));
  }, [canSeeConflicts, projectId, form.studyId, form.templateId]);

  useEffect(loadConflicts, [loadConflicts]);

  function isFieldEditable(fieldId: string): boolean {
    if (!isMine) return false;
    if (conflictInfo?.resolved.has(fieldId)) return false; // adjudicated → locked
    if (form.status === "IN_PROGRESS") return true;
    if (conflictInfo?.open.has(fieldId)) return true;
    return unlockedFields.has(fieldId);
  }

  async function persistValue(field: TemplateField, committed: unknown) {
    const next = committed === undefined ? null : committed;
    const current = values[field.id]?.value ?? null;
    if (JSON.stringify(next) === JSON.stringify(current)) return; // no change (e.g. blur)
    setSaveStates((p) => ({ ...p, [field.id]: { status: "saving" } }));
    try {
      const saved = await apiPut<FormValue | null>(
        `/api/projects/${projectId}/extraction-forms/${form.id}/values/${field.id}`,
        { value: next },
      );
      setValues((prev) => {
        const nextMap = { ...prev };
        if (saved === null) delete nextMap[field.id];
        else nextMap[field.id] = saved;
        return nextMap;
      });
      setSaveStates((p) => ({ ...p, [field.id]: { status: "saved" } }));
      setMissingKeys((p) => {
        if (!p.has(field.key)) return p;
        const n = new Set(p);
        n.delete(field.key);
        return n;
      });
      // On a completed form this was a disputed-field edit — agreement may auto-void it.
      if (form.status === "COMPLETED") loadConflicts();
    } catch (err) {
      const message = err instanceof ApiError ? err.message : "Failed to save value";
      setSaveStates((p) => ({ ...p, [field.id]: { status: "error", message } }));
    }
  }

  async function complete() {
    setCompleting(true);
    try {
      const updated = await apiPost<{ status: FormStatus; completedAt?: string | null }>(
        `/api/projects/${projectId}/extraction-forms/${form.id}/complete`,
      );
      setForm((f) => ({ ...f, status: updated.status, completedAt: updated.completedAt ?? null }));
      setMissingKeys(new Set());
      toast.success("Extraction form completed");
      loadConflicts(); // completion may open conflicts against the other extractor's form
    } catch (err) {
      if (err instanceof ApiError) {
        const raw: unknown = err.details;
        let missing: string[] = [];
        if (raw && typeof raw === "object" && "missing" in raw) {
          const m = (raw as { missing: unknown }).missing;
          if (Array.isArray(m)) missing = m.filter((k): k is string => typeof k === "string");
        }
        if (missing.length > 0) setMissingKeys(new Set(missing));
        toast.error(err.message);
      } else {
        toast.error("Failed to complete form");
      }
    } finally {
      setCompleting(false);
    }
  }

  const fields = template?.fields ?? null;
  const filledCount = fields ? fields.filter((f) => values[f.id] !== undefined).length : 0;
  const requiredMissing = fields
    ? fields.filter((f) => f.required && values[f.id] === undefined).length
    : 0;

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <Button variant="ghost" size="sm" onClick={onClose}>
            <ArrowLeft /> Studies
          </Button>
          <div>
            <h2 className="text-lg font-semibold tracking-tight">{form.study.label}</h2>
            <p className="text-sm text-muted-foreground">
              {form.template.name} v{form.template.version} · extractor {form.extractor.name}
              {isMine ? " (you)" : ""}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <FormStatusBadge status={form.status} />
          {isMine && form.status === "IN_PROGRESS" && (
            <Button onClick={complete} disabled={completing}>
              {completing ? <Spinner /> : <Check />} Complete form
            </Button>
          )}
        </div>
      </div>

      {!isMine && (
        <Alert variant="info">
          Read-only — only {form.extractor.name} can edit the values on this form.
        </Alert>
      )}
      {isMine && form.status === "COMPLETED" && (
        <Alert variant={conflictInfo && conflictInfo.open.size > 0 ? "warning" : "info"}>
          {conflictInfo === null
            ? "Completed — values are locked, except fields with an open extraction conflict. Use Edit on a disputed field to update your value; the server will refuse edits elsewhere."
            : conflictInfo.open.size > 0
              ? `Completed — ${conflictInfo.open.size} field${conflictInfo.open.size === 1 ? " has" : "s have"} an open conflict and stay${conflictInfo.open.size === 1 ? "s" : ""} editable until adjudicated (or until extractors converge).`
              : `Completed${form.completedAt ? ` on ${new Date(form.completedAt).toLocaleDateString()}` : ""} — values are locked.`}
        </Alert>
      )}

      {fields === null ? (
        <div className="space-y-3">
          <Skeleton className="h-6 w-64" />
          <Skeleton className="h-24" />
          <Skeleton className="h-24" />
          <Skeleton className="h-24" />
        </div>
      ) : (
        <>
          <div className="flex items-center gap-3">
            <Progress value={fields.length === 0 ? 0 : (filledCount / fields.length) * 100} className="max-w-xs" />
            <p className="text-xs text-muted-foreground">
              {filledCount} / {fields.length} fields recorded
              {requiredMissing > 0 ? ` · ${requiredMissing} required remaining` : ""}
            </p>
          </div>
          <div className="space-y-3">
            {fields.map((field, i) => {
              const prev = i > 0 ? fields[i - 1] : undefined;
              const showSection =
                typeof field.section === "string" &&
                field.section !== "" &&
                field.section !== prev?.section;
              const savedRow = values[field.id];
              const currentValue = savedRow?.value ?? null;
              const editable = isFieldEditable(field.id);
              const disputed = conflictInfo?.open.has(field.id) ?? false;
              const adjudicated = conflictInfo?.resolved.has(field.id) ?? false;
              const showUnlockButton =
                isMine &&
                form.status === "COMPLETED" &&
                conflictInfo === null &&
                !unlockedFields.has(field.id);
              return (
                <Fragment key={field.id}>
                  {showSection && (
                    <h3 className="pt-3 text-sm font-semibold text-muted-foreground">
                      {field.section}
                    </h3>
                  )}
                  <div className="rounded-lg border border-border bg-card p-4">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <Label htmlFor={`fv-${field.id}`} className="flex items-center gap-1.5">
                        {field.label}
                        {field.required && (
                          <span className="text-exclude" title="Required">
                            *
                          </span>
                        )}
                        <span className="font-mono text-[11px] font-normal text-muted-foreground">
                          {field.key}
                        </span>
                      </Label>
                      <div className="flex items-center gap-2">
                        {disputed && <Badge variant="maybe">open conflict</Badge>}
                        {adjudicated && (
                          <Badge variant="muted">
                            <Lock className="mr-1 h-3 w-3" /> adjudicated
                          </Badge>
                        )}
                        <SaveIndicator state={saveStates[field.id]} />
                        {showUnlockButton && (
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() =>
                              setUnlockedFields((p) => {
                                const n = new Set(p);
                                n.add(field.id);
                                return n;
                              })
                            }
                          >
                            <Pencil /> Edit
                          </Button>
                        )}
                      </div>
                    </div>
                    {field.helpText && (
                      <p className="mt-1 text-xs text-muted-foreground">{field.helpText}</p>
                    )}
                    <div className="mt-2">
                      {editable ? (
                        <FieldValueEditor
                          field={field}
                          value={currentValue}
                          onCommit={(v) => persistValue(field, v)}
                        />
                      ) : (
                        <p
                          className={
                            currentValue === null
                              ? "text-sm italic text-muted-foreground"
                              : "text-sm"
                          }
                        >
                          {formatFieldValue(field, currentValue)}
                        </p>
                      )}
                    </div>
                    {missingKeys.has(field.key) && (
                      <p className="mt-1.5 text-xs text-exclude">
                        Required — record a value before completing.
                      </p>
                    )}
                    {savedRow?.sourceQuote && (
                      <p className="mt-2 border-l-2 border-border pl-2 text-xs italic text-muted-foreground">
                        &ldquo;{savedRow.sourceQuote}&rdquo;
                        {savedRow.pageNumber ? ` (p. ${savedRow.pageNumber})` : ""}
                      </p>
                    )}
                  </div>
                </Fragment>
              );
            })}
          </div>
          {isMine && form.status === "IN_PROGRESS" && fields.length > 0 && (
            <div className="flex justify-end">
              <Button onClick={complete} disabled={completing}>
                {completing ? <Spinner /> : <Check />} Complete form
              </Button>
            </div>
          )}
        </>
      )}
    </div>
  );
}
