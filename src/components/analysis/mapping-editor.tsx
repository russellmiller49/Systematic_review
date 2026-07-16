"use client";

// Maps each statistical role the selected outcome requires (e.g. G1_EVENTS) to a
// NUMBER field on an extraction template. Mappings are stored as (templateId,
// fieldKey) pairs — the server resolves values across the template's version
// lineage, so a mapping survives republishing. Save replaces the full set.

import { useEffect, useMemo, useState } from "react";
import { Save } from "lucide-react";
import { toast } from "sonner";
import { apiPut } from "@/lib/api";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Alert, Spinner } from "@/components/ui/misc";
import { Select } from "@/components/ui/select";
import type { Template, TemplateField } from "@/components/extraction/types";
import {
  apiErrorMessages,
  resolveGroupLabels,
  roleLabel,
  type AnalysisOutcomeRow,
} from "./types";

interface DraftMapping {
  templateId: string;
  fieldKey: string;
}

const STATUS_WEIGHT: Record<string, number> = { PUBLISHED: 0, DRAFT: 1, ARCHIVED: 2 };

// NUMBER fields of a template, grouped by section in field order (for <optgroup>).
function numberFieldGroups(template: Template): { section: string; fields: TemplateField[] }[] {
  const groups: { section: string; fields: TemplateField[] }[] = [];
  const fields = template.fields
    .filter((f) => f.type === "NUMBER")
    .sort((a, b) => a.order - b.order);
  for (const field of fields) {
    const section = field.section ?? "";
    const existing = groups.find((g) => g.section === section);
    if (existing) existing.fields.push(field);
    else groups.push({ section, fields: [field] });
  }
  return groups;
}

export function MappingEditor({
  projectId,
  outcome,
  templates,
  canManage,
  onSaved,
}: {
  projectId: string;
  outcome: AnalysisOutcomeRow;
  templates: Template[] | null;
  canManage: boolean;
  onSaved: (row: AnalysisOutcomeRow) => void;
}) {
  const [draft, setDraft] = useState<Record<string, DraftMapping>>({});
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [errors, setErrors] = useState<string[]>([]);

  // Re-sync the draft whenever the outcome (or its saved mappings) changes.
  useEffect(() => {
    const next: Record<string, DraftMapping> = {};
    for (const m of outcome.mappings) next[m.role] = { templateId: m.templateId, fieldKey: m.fieldKey };
    setDraft(next);
    setDirty(false);
    setErrors([]);
  }, [outcome]);

  // Published templates first — those are what extraction runs against. Drafts are
  // not mappable (their fields are still deletable, which would orphan the mapping;
  // the server rejects them too).
  const sortedTemplates = useMemo(
    () =>
      (templates ?? [])
        .filter((t) => t.status !== "DRAFT")
        .sort(
          (a, b) =>
            (STATUS_WEIGHT[a.status] ?? 3) - (STATUS_WEIGHT[b.status] ?? 3) ||
            a.name.localeCompare(b.name),
        ),
    [templates],
  );

  const groups = resolveGroupLabels(outcome.groupLabels);

  function setTemplate(role: string, templateId: string) {
    setDraft((prev) => {
      const next = { ...prev };
      if (!templateId) delete next[role];
      else next[role] = { templateId, fieldKey: "" };
      return next;
    });
    setDirty(true);
    setErrors([]);
  }

  function setField(role: string, fieldKey: string) {
    setDraft((prev) => {
      const current = prev[role];
      if (!current) return prev;
      return { ...prev, [role]: { templateId: current.templateId, fieldKey } };
    });
    setDirty(true);
    setErrors([]);
  }

  async function save() {
    const halfMapped = outcome.requiredRoles.filter((role) => {
      const m = draft[role];
      return m !== undefined && !m.fieldKey;
    });
    if (halfMapped.length > 0) {
      setErrors(
        halfMapped.map(
          (role) => `${roleLabel(role, groups)}: pick a field or set the template to "Not mapped".`,
        ),
      );
      return;
    }
    const mappings = outcome.requiredRoles.flatMap((role) => {
      const m = draft[role];
      return m && m.fieldKey ? [{ role, templateId: m.templateId, fieldKey: m.fieldKey }] : [];
    });
    setBusy(true);
    try {
      const updated = await apiPut<AnalysisOutcomeRow>(
        `/api/projects/${projectId}/analysis/outcomes/${outcome.id}/mappings`,
        { mappings },
      );
      toast.success("Mappings saved");
      setDirty(false);
      onSaved(updated);
    } catch (err) {
      setErrors(apiErrorMessages(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <div className="flex items-start justify-between gap-3">
          <div>
            <CardTitle className="text-base">Field mappings</CardTitle>
            <CardDescription className="mt-1">
              Each statistical role needs a NUMBER field from an extraction template.
            </CardDescription>
          </div>
          <Badge variant={outcome.mappingComplete ? "include" : "maybe"}>
            {outcome.mappingComplete ? "Complete" : "Incomplete"}
          </Badge>
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        {errors.length > 0 && (
          <Alert variant="error">
            <ul className="list-inside list-disc space-y-0.5">
              {errors.map((m) => (
                <li key={m}>{m}</li>
              ))}
            </ul>
          </Alert>
        )}

        {outcome.requiredRoles.map((role) => {
          const m = draft[role];
          const template = m ? sortedTemplates.find((t) => t.id === m.templateId) : undefined;
          return (
            <div
              key={role}
              className="grid gap-2 sm:grid-cols-[minmax(9rem,13rem)_1fr_1fr] sm:items-center"
            >
              <div>
                <span className="text-sm font-medium">{roleLabel(role, groups)}</span>
                <span className="block text-xs text-muted-foreground">{role}</span>
              </div>
              {canManage ? (
                <>
                  <Select
                    aria-label={`Template for ${role}`}
                    value={m?.templateId ?? ""}
                    onChange={(e) => setTemplate(role, e.target.value)}
                  >
                    <option value="">Not mapped</option>
                    {sortedTemplates.map((t) => (
                      <option key={t.id} value={t.id}>
                        {t.name} (v{t.version}
                        {t.status !== "PUBLISHED" ? `, ${t.status.toLowerCase()}` : ""})
                      </option>
                    ))}
                  </Select>
                  <Select
                    aria-label={`Field for ${role}`}
                    value={m?.fieldKey ?? ""}
                    disabled={!template}
                    onChange={(e) => setField(role, e.target.value)}
                  >
                    {template && numberFieldGroups(template).length === 0 ? (
                      <option value="">No NUMBER fields on this template</option>
                    ) : (
                      <option value="">Select a field…</option>
                    )}
                    {template &&
                      numberFieldGroups(template).map((group) => (
                        <optgroup key={group.section} label={group.section || "General"}>
                          {group.fields.map((f) => (
                            <option key={f.id} value={f.key}>
                              {f.label} ({f.key})
                            </option>
                          ))}
                        </optgroup>
                      ))}
                  </Select>
                </>
              ) : (
                <p className="text-sm text-muted-foreground sm:col-span-2">
                  {m
                    ? `${template?.name ?? "Unknown template"} · ${
                        template?.fields.find((f) => f.key === m.fieldKey)?.label ?? m.fieldKey
                      } (${m.fieldKey})`
                    : "Not mapped"}
                </p>
              )}
            </div>
          );
        })}

        {canManage && (
          <div className="flex justify-end pt-1">
            <Button size="sm" onClick={() => void save()} disabled={busy || !dirty}>
              {busy ? <Spinner className="h-3.5 w-3.5" /> : <Save />} Save mappings
            </Button>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
