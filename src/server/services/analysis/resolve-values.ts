// Analysis value resolution — turns raw extraction data into per-(study, role) numbers.
// The analysis module consumes extraction data READ-ONLY through this file.
//
// Layer 1 (pure, unit-tested): resolveNumericField mirrors the extraction matrix's
// resolution precedence (matrix-resolve.ts) for NUMBER fields and adds an opt-in
// PROVISIONAL tier sourced from IN_PROGRESS forms; expandTemplateLineage computes a
// template's full version tree so mappings survive template versioning.
// Layer 2 (fetch wrapper): batched Prisma reads — one findMany for forms+values across
// every lineage template, one for conflicts (+ adjudications) — then pure resolution
// per (study, role). No N+1, no writes.
//
// Version precedence: extraction conflict detection is scoped to a single template
// version (evaluateFieldConflicts), so cross-version disagreement can never open a
// conflict and must never surface as one here. Per (study, role) the NEWEST lineage
// version with any final signal (a completed value or a live conflict) wins outright;
// older versions are superseded by re-extraction, never pooled with it.
//
// Blinding: with `blinded: true` (callers without extraction.adjudicate/project.edit),
// the PROVISIONAL tier is unavailable and a SINGLE value is withheld while any lineage
// version still has open extraction work for that study — otherwise an assigned
// co-extractor could read their counterpart's pre-consensus numbers through analysis
// results, which listForms/getExtractionMatrix deliberately forbid (R1 blind mirror).

import type { AnalysisRole } from "@prisma/client";
import { prisma, type Tx } from "@/server/db";
import { valuesEqual } from "@/server/services/extraction/validation";

// ---------------------------------------------------------------------------
// Pure: numeric field resolution
// ---------------------------------------------------------------------------

export type NumericSource = "ADJUDICATED" | "CONSENSUS" | "SINGLE" | "PROVISIONAL";

export interface ResolvedNumeric {
  value: number | null;
  source: NumericSource | null;
  disputed: boolean;
}

export interface ResolveNumericInput {
  completed: { value: unknown }[]; // values from COMPLETED forms
  inProgress: { value: unknown }[]; // values from IN_PROGRESS forms
  adjudicatedValue?: unknown; // ExtractionAdjudication.finalValue when RESOLVED
  conflictStatus?: "OPEN" | "RESOLVED" | "VOIDED" | null;
  includeProvisional: boolean;
}

// Precedence (mirrors resolveMatrixCell; VOIDED conflicts are ignored):
//   1. RESOLVED conflict + adjudicated value  -> ADJUDICATED
//   2. OPEN conflict                          -> disputed
//   3. >=2 completed, all equal               -> CONSENSUS
//      exactly 1 completed                    -> SINGLE
//      >=2 completed, differing               -> disputed
//   4. nothing completed + includeProvisional: in-progress all equal -> PROVISIONAL,
//      differing -> disputed
//   5. otherwise missing.
// A resolved value that is not a finite number is treated as missing, never disputed.
export function resolveNumericField(input: ResolveNumericInput): ResolvedNumeric {
  if (input.conflictStatus === "RESOLVED" && input.adjudicatedValue !== undefined) {
    return asNumeric(input.adjudicatedValue, "ADJUDICATED");
  }
  if (input.conflictStatus === "OPEN") {
    return { value: null, source: null, disputed: true };
  }

  const completed = input.completed;
  if (completed.length === 1) {
    return asNumeric(completed[0]!.value, "SINGLE");
  }
  if (completed.length >= 2) {
    const first = completed[0]!;
    const allEqual = completed.every((e) => valuesEqual("NUMBER", first.value, e.value));
    if (allEqual) return asNumeric(first.value, "CONSENSUS");
    // Disagreeing completed forms (conflict row may lag) — disputed.
    return { value: null, source: null, disputed: true };
  }

  // Nothing completed: the provisional tier only exists when explicitly requested.
  if (input.includeProvisional && input.inProgress.length > 0) {
    const first = input.inProgress[0]!;
    const allEqual = input.inProgress.every((e) => valuesEqual("NUMBER", first.value, e.value));
    if (allEqual) return asNumeric(first.value, "PROVISIONAL");
    return { value: null, source: null, disputed: true };
  }

  return { value: null, source: null, disputed: false };
}

function asNumeric(value: unknown, source: NumericSource): ResolvedNumeric {
  if (typeof value === "number" && Number.isFinite(value)) {
    return { value, source, disputed: false };
  }
  return { value: null, source: null, disputed: false };
}

// ---------------------------------------------------------------------------
// Pure: template version lineage
// ---------------------------------------------------------------------------

export interface TemplateLineageNode {
  id: string;
  sourceTemplateId: string | null;
}

// The full version tree containing templateId: walk sourceTemplateId up to the root,
// then pull in every template whose sourceTemplateId chains into that set. Cycle-safe
// (Set membership guards both directions).
export function expandTemplateLineage(
  templates: TemplateLineageNode[],
  templateId: string,
): Set<string> {
  const byId = new Map(templates.map((t) => [t.id, t]));
  const lineage = new Set<string>([templateId]);

  let cursor = byId.get(templateId)?.sourceTemplateId ?? null;
  while (cursor && !lineage.has(cursor)) {
    lineage.add(cursor);
    cursor = byId.get(cursor)?.sourceTemplateId ?? null;
  }

  let grew = true;
  while (grew) {
    grew = false;
    for (const template of templates) {
      if (
        !lineage.has(template.id) &&
        template.sourceTemplateId !== null &&
        lineage.has(template.sourceTemplateId)
      ) {
        lineage.add(template.id);
        grew = true;
      }
    }
  }
  return lineage;
}

// ---------------------------------------------------------------------------
// Fetch wrapper: batched extraction reads + resolution per (study, role)
// ---------------------------------------------------------------------------

export interface RoleMapping {
  role: AnalysisRole;
  templateId: string;
  fieldKey: string;
}

export type StudyRoleValues = Map<string, Partial<Record<AnalysisRole, ResolvedNumeric>>>;

export async function fetchResolvedRoleValues(input: {
  projectId: string;
  studyIds: string[];
  mappings: RoleMapping[];
  includeProvisional: boolean;
  // R1 blind mirror for callers without extraction.adjudicate/project.edit: no
  // PROVISIONAL tier, and SINGLE values are withheld while extraction is still open.
  blinded?: boolean;
  db?: Tx;
}): Promise<StudyRoleValues> {
  const out: StudyRoleValues = new Map(input.studyIds.map((id) => [id, {}]));
  if (input.mappings.length === 0 || input.studyIds.length === 0) return out;
  const blinded = input.blinded === true;
  const includeProvisional = input.includeProvisional && !blinded;
  const db = input.db ?? prisma;

  // One load of the project's template graph (with fields); lineage math is in-memory.
  const templates = await db.extractionTemplate.findMany({
    where: { projectId: input.projectId },
    select: {
      id: true,
      sourceTemplateId: true,
      version: true,
      createdAt: true,
      fields: { select: { id: true, key: true, type: true } },
    },
  });
  // Deterministic newest-first order for version precedence (createdAt/id break the
  // tie between sibling versions branched from the same source).
  const orderedTemplates = [...templates].sort(
    (a, b) =>
      b.version - a.version ||
      b.createdAt.getTime() - a.createdAt.getTime() ||
      (a.id < b.id ? 1 : -1),
  );

  // Per role: the concrete fields carrying the mapped key across the full lineage,
  // newest version first. Only NUMBER fields count — a re-typed key on another version
  // cannot feed the stats.
  const fieldRefsByRole = new Map<AnalysisRole, { fieldId: string; templateId: string }[]>();
  const lineageTemplateIdsByRole = new Map<AnalysisRole, string[]>();
  const allFieldIds = new Set<string>();
  const allTemplateIds = new Set<string>();
  for (const mapping of input.mappings) {
    const lineage = expandTemplateLineage(templates, mapping.templateId);
    const refs: { fieldId: string; templateId: string }[] = [];
    const lineageIds: string[] = [];
    for (const template of orderedTemplates) {
      if (!lineage.has(template.id)) continue;
      allTemplateIds.add(template.id);
      lineageIds.push(template.id);
      for (const field of template.fields) {
        if (field.key === mapping.fieldKey && field.type === "NUMBER") {
          refs.push({ fieldId: field.id, templateId: template.id });
          allFieldIds.add(field.id);
        }
      }
    }
    fieldRefsByRole.set(mapping.role, refs);
    lineageTemplateIdsByRole.set(mapping.role, lineageIds);
  }

  const [forms, conflicts, pendingAssignments] = await Promise.all([
    db.extractionForm.findMany({
      where: {
        templateId: { in: [...allTemplateIds] },
        studyId: { in: input.studyIds },
      },
      select: {
        templateId: true,
        studyId: true,
        status: true,
        values: {
          where: { fieldId: { in: [...allFieldIds] } },
          select: { fieldId: true, value: true },
        },
      },
    }),
    db.extractionConflict.findMany({
      where: {
        studyId: { in: input.studyIds },
        fieldId: { in: [...allFieldIds] },
      },
      select: {
        studyId: true,
        fieldId: true,
        status: true,
        adjudication: { select: { finalValue: true } },
      },
    }),
    // Open-work signal for the blind: only fetched when it can matter.
    blinded
      ? db.extractionAssignment.findMany({
          where: {
            templateId: { in: [...allTemplateIds] },
            studyId: { in: input.studyIds },
            status: "PENDING",
          },
          select: { templateId: true, studyId: true },
        })
      : Promise.resolve([]),
  ]);

  // Group values by (study, field), split by form status.
  const entriesByCell = new Map<string, { completed: { value: unknown }[]; inProgress: { value: unknown }[] }>();
  const openWorkCells = new Set<string>(); // `${templateId}:${studyId}` with live extraction work
  for (const form of forms) {
    if (form.status === "IN_PROGRESS") openWorkCells.add(`${form.templateId}:${form.studyId}`);
    for (const value of form.values) {
      const key = `${form.studyId}:${value.fieldId}`;
      let bucket = entriesByCell.get(key);
      if (!bucket) {
        bucket = { completed: [], inProgress: [] };
        entriesByCell.set(key, bucket);
      }
      (form.status === "COMPLETED" ? bucket.completed : bucket.inProgress).push({
        value: value.value,
      });
    }
  }
  for (const assignment of pendingAssignments) {
    openWorkCells.add(`${assignment.templateId}:${assignment.studyId}`);
  }
  const conflictByCell = new Map(conflicts.map((c) => [`${c.studyId}:${c.fieldId}`, c]));

  for (const studyId of input.studyIds) {
    const roleValues: Partial<Record<AnalysisRole, ResolvedNumeric>> = {};
    for (const [role, refs] of fieldRefsByRole) {
      // Version precedence: the newest lineage version with a final signal (completed
      // value, or a live conflict) resolves the role by itself; older versions are
      // superseded. A conflict is "live" when OPEN, or RESOLVED with its adjudication.
      type Cell = { completed: { value: unknown }[]; inProgress: { value: unknown }[] };
      let entries: Cell | undefined;
      let conflict: (typeof conflicts)[number] | undefined;
      for (const ref of refs) {
        const cellEntries = entriesByCell.get(`${studyId}:${ref.fieldId}`);
        const cellConflict = conflictByCell.get(`${studyId}:${ref.fieldId}`);
        const liveConflict =
          cellConflict?.status === "OPEN" ||
          (cellConflict?.status === "RESOLVED" && cellConflict.adjudication !== null);
        if ((cellEntries?.completed.length ?? 0) > 0 || liveConflict) {
          entries = cellEntries;
          conflict = liveConflict ? cellConflict : undefined;
          break;
        }
      }
      if (!entries && includeProvisional) {
        // No final signal on any version — the provisional tier reads the newest
        // version that has in-progress values.
        for (const ref of refs) {
          const cellEntries = entriesByCell.get(`${studyId}:${ref.fieldId}`);
          if ((cellEntries?.inProgress.length ?? 0) > 0) {
            entries = cellEntries;
            break;
          }
        }
      }
      let resolvedNumeric = resolveNumericField({
        completed: entries?.completed ?? [],
        inProgress: entries?.inProgress ?? [],
        adjudicatedValue:
          conflict?.status === "RESOLVED" && conflict.adjudication
            ? (conflict.adjudication.finalValue as unknown)
            : undefined,
        conflictStatus: conflict?.status === "OPEN" || conflict?.status === "RESOLVED"
          ? conflict.status
          : null,
        includeProvisional,
      });
      // Blind: one completed form is pre-consensus data while a co-extraction is still
      // open anywhere in the lineage (in-progress form or pending assignment) — withhold
      // it from blinded callers rather than leak a lone extractor's numbers.
      if (blinded && resolvedNumeric.source === "SINGLE") {
        const lineageIds = lineageTemplateIdsByRole.get(role) ?? [];
        const open = lineageIds.some((templateId) => openWorkCells.has(`${templateId}:${studyId}`));
        if (open) resolvedNumeric = { value: null, source: null, disputed: false };
      }
      roleValues[role] = resolvedNumeric;
    }
    out.set(studyId, roleValues);
  }
  return out;
}
