// Analysis domain service — meta-analyzable outcomes, field-role mappings, manual study
// exclusions, and result computation. Consumes extraction data READ-ONLY through
// resolve-values.ts and delegates all statistics to the pure stats library.
//
// Contract highlights:
//   - Measures: RR/OR/RD (binary 2x2), MD/SMD (continuous), PROPORTION (single-arm
//     e/n; logit or Freeman–Tukey transform, editable any time — results recompute
//     live), GENERIC_IV (pre-computed estimate + SE, or SE derived from 95% CI
//     bounds). Measure is immutable after creation.
//   - R9: outcome loads are project-scoped; outcomeDefinitionId / templateId / studyId
//     from request bodies must belong to the path project.
//   - Mappings are replace-all: each role points at (templateId, fieldKey) where the
//     field exists on that template and is a NUMBER field. The resolver expands the
//     template's version lineage so mappings survive template versioning.
//   - Manual exclusions short-circuit BEFORE value resolution; the stats engine is the
//     sole authority on statistical rejections (e.g. double-zero studies).

import { z } from "zod";
import { AnalysisRole, Prisma, type EffectMeasure } from "@prisma/client";
import { prisma, type Tx } from "@/server/db";
import { notFound, validationError } from "@/server/errors";
import type { Ctx } from "@/server/auth/session";
import { can, requirePermission } from "@/server/permissions";
import * as audit from "@/server/services/audit";
import { AuditActions } from "@/server/services/audit";
import { computeMeta } from "@/lib/stats/meta";
import type {
  AnalysisScale,
  DisplayMeta,
  EffectMeasureId,
  EggerResult,
  Heterogeneity,
  PooledEstimate,
  PredictionInterval,
  ProportionTransformId,
  StudyData,
  StudyEffectInput,
  StudyEffectResult,
} from "@/lib/stats/types";
import { fetchResolvedRoleValues, type NumericSource } from "./resolve-values";

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

export const ALL_MEASURES = ["RR", "OR", "RD", "MD", "SMD", "PROPORTION", "GENERIC_IV"] as const;
const PROPORTION_TRANSFORMS = ["LOGIT", "FREEMAN_TUKEY"] as const;

const groupLabelsSchema = z.object({
  g1: z.string().trim().max(120).optional(),
  g2: z.string().trim().max(120).optional(),
});

export const createOutcomeSchema = z.object({
  name: z.string().trim().min(1).max(300),
  measure: z.enum(ALL_MEASURES),
  timepoint: z.string().trim().max(200).optional(),
  direction: z.enum(["HIGHER_IS_BETTER", "LOWER_IS_BETTER"]).optional(),
  model: z.enum(["FIXED", "RANDOM"]).optional(),
  groupLabels: groupLabelsSchema.optional(),
  outcomeDefinitionId: z.string().min(1).optional(),
  proportionTransform: z.enum(PROPORTION_TRANSFORMS).optional(), // PROPORTION only (default LOGIT)
});

// Same as create minus measure (immutable); nullables clear the stored value.
// proportionTransform is editable any time — results are recomputed live, never stored.
export const updateOutcomeSchema = z.object({
  name: z.string().trim().min(1).max(300).optional(),
  timepoint: z.string().trim().max(200).nullable().optional(),
  direction: z.enum(["HIGHER_IS_BETTER", "LOWER_IS_BETTER"]).optional(),
  model: z.enum(["FIXED", "RANDOM"]).optional(),
  groupLabels: groupLabelsSchema.nullable().optional(),
  outcomeDefinitionId: z.string().min(1).nullable().optional(),
  proportionTransform: z.enum(PROPORTION_TRANSFORMS).optional(),
});

export const replaceMappingsSchema = z.object({
  mappings: z
    .array(
      z.object({
        role: z.nativeEnum(AnalysisRole),
        templateId: z.string().min(1),
        fieldKey: z.string().min(1),
      }),
    )
    .max(20),
});

export const setExclusionSchema = z
  .object({
    excluded: z.boolean(),
    reason: z.string().trim().min(3).max(1000).optional(),
  })
  .refine((v) => !v.excluded || v.reason !== undefined, {
    message: "A reason is required when excluding a study",
    path: ["reason"],
  });

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const BINARY_ROLES: AnalysisRole[] = ["G1_EVENTS", "G1_TOTAL", "G2_EVENTS", "G2_TOTAL"];
const CONTINUOUS_ROLES: AnalysisRole[] = ["G1_MEAN", "G1_SD", "G1_N", "G2_MEAN", "G2_SD", "G2_N"];
const PROPORTION_ROLES: AnalysisRole[] = ["G1_EVENTS", "G1_TOTAL"]; // single arm: G1 = the cohort
// GENERIC_IV accepts all four EFFECT_* roles; completeness is se-source aware (see below).
const GENERIC_ROLES: AnalysisRole[] = [
  "EFFECT_ESTIMATE",
  "EFFECT_SE",
  "EFFECT_CI_LOW",
  "EFFECT_CI_UP",
];

export function requiredRolesFor(measure: EffectMeasure): AnalysisRole[] {
  switch (measure) {
    case "RR":
    case "OR":
    case "RD":
      return BINARY_ROLES;
    case "MD":
    case "SMD":
      return CONTINUOUS_ROLES;
    case "PROPORTION":
      return PROPORTION_ROLES;
    case "GENERIC_IV":
      return GENERIC_ROLES;
    default:
      return [];
  }
}

// Measure-aware mapping completeness: GENERIC_IV needs the estimate plus EITHER a
// standard error OR both 95% CI bounds; every other measure needs all its roles.
export function isMappingComplete(
  measure: EffectMeasure,
  mapped: ReadonlySet<AnalysisRole>,
): boolean {
  if (measure === "GENERIC_IV") {
    return (
      mapped.has("EFFECT_ESTIMATE") &&
      (mapped.has("EFFECT_SE") || (mapped.has("EFFECT_CI_LOW") && mapped.has("EFFECT_CI_UP")))
    );
  }
  return requiredRolesFor(measure).every((role) => mapped.has(role));
}

// AnalysisOutcome.groupLabels is Json? — normalize to the typed shape (null if unusable).
function parseGroupLabels(value: unknown): { g1?: string; g2?: string } | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  const labels: { g1?: string; g2?: string } = {};
  if (typeof raw.g1 === "string" && raw.g1 !== "") labels.g1 = raw.g1;
  if (typeof raw.g2 === "string" && raw.g2 !== "") labels.g2 = raw.g2;
  return labels.g1 !== undefined || labels.g2 !== undefined ? labels : null;
}

export interface AnalysisOutcomeRow {
  id: string;
  name: string;
  timepoint: string | null;
  measure: EffectMeasureId;
  direction: "HIGHER_IS_BETTER" | "LOWER_IS_BETTER";
  model: "FIXED" | "RANDOM";
  proportionTransform: ProportionTransformId; // meaningful for PROPORTION only
  groupLabels: { g1?: string; g2?: string } | null;
  order: number;
  outcomeDefinitionId: string | null;
  mappings: { role: AnalysisRole; templateId: string; fieldKey: string }[];
  requiredRoles: AnalysisRole[];
  mappingComplete: boolean;
}

type OutcomeWithMappings = Prisma.AnalysisOutcomeGetPayload<{ include: { mappings: true } }>;

// Exported for scaffold.ts (same service family) — not part of the route surface.
export function toRow(outcome: OutcomeWithMappings): AnalysisOutcomeRow {
  const requiredRoles = requiredRolesFor(outcome.measure);
  const mapped = new Set(outcome.mappings.map((m) => m.role));
  // Stable ordering: required-role order first, any stragglers after.
  const roleIndex = (role: AnalysisRole) => {
    const i = requiredRoles.indexOf(role);
    return i === -1 ? requiredRoles.length : i;
  };
  return {
    id: outcome.id,
    name: outcome.name,
    timepoint: outcome.timepoint,
    measure: outcome.measure as EffectMeasureId,
    direction: outcome.direction,
    model: outcome.model,
    proportionTransform: outcome.proportionTransform,
    groupLabels: parseGroupLabels(outcome.groupLabels),
    order: outcome.order,
    outcomeDefinitionId: outcome.outcomeDefinitionId,
    mappings: [...outcome.mappings]
      .sort((a, b) => roleIndex(a.role) - roleIndex(b.role))
      .map((m) => ({ role: m.role, templateId: m.templateId, fieldKey: m.fieldKey })),
    requiredRoles,
    mappingComplete: isMappingComplete(outcome.measure, mapped),
  };
}

// R9: by-id load is project-scoped; miss -> 404.
async function loadOutcome(db: Tx, projectId: string, outcomeId: string) {
  const outcome = await db.analysisOutcome.findFirst({
    where: { id: outcomeId, projectId },
    include: { mappings: true },
  });
  if (!outcome) throw notFound("Analysis outcome");
  return outcome;
}

// Analysis metadata mutations and GRADE assessment mutations serialize on the same
// always-present parent row. This prevents a mapping/model/exclusion write from crossing
// a GRADE snapshot boundary while still allowing unrelated outcomes to proceed.
async function lockOutcomeForMutation(db: Tx, projectId: string, outcomeId: string) {
  const locked = await db.$queryRaw<{ id: string }[]>`
    SELECT "id"
    FROM "AnalysisOutcome"
    WHERE "id" = ${outcomeId} AND "projectId" = ${projectId}
    FOR UPDATE
  `;
  if (locked.length === 0) throw notFound("Analysis outcome");
}

// R9: a body-supplied outcomeDefinitionId must belong to the project's protocol.
async function assertOutcomeDefinitionInProject(
  tx: Tx,
  projectId: string,
  outcomeDefinitionId: string,
) {
  const definition = await tx.outcomeDefinition.findFirst({
    where: { id: outcomeDefinitionId, protocol: { projectId } },
    select: { id: true },
  });
  if (!definition) throw notFound("Outcome definition");
}

// ---------------------------------------------------------------------------
// Outcomes CRUD
// ---------------------------------------------------------------------------

export async function listOutcomes(ctx: Ctx, projectId: string): Promise<AnalysisOutcomeRow[]> {
  await requirePermission(ctx, projectId, "analysis.view");
  const outcomes = await prisma.analysisOutcome.findMany({
    where: { projectId },
    include: { mappings: true },
    orderBy: [{ order: "asc" }, { createdAt: "asc" }],
  });
  return outcomes.map(toRow);
}

export async function getOutcome(
  ctx: Ctx,
  projectId: string,
  outcomeId: string,
): Promise<AnalysisOutcomeRow> {
  await requirePermission(ctx, projectId, "analysis.view");
  return toRow(await loadOutcome(prisma, projectId, outcomeId));
}

export async function createOutcome(
  ctx: Ctx,
  projectId: string,
  input: z.infer<typeof createOutcomeSchema>,
): Promise<AnalysisOutcomeRow> {
  await requirePermission(ctx, projectId, "analysis.manage");
  return prisma.$transaction(async (tx) => {
    if (input.outcomeDefinitionId) {
      await assertOutcomeDefinitionInProject(tx, projectId, input.outcomeDefinitionId);
    }
    const order = await tx.analysisOutcome.count({ where: { projectId } });
    const outcome = await tx.analysisOutcome.create({
      data: {
        projectId,
        name: input.name,
        measure: input.measure,
        timepoint: input.timepoint ?? null,
        ...(input.direction !== undefined ? { direction: input.direction } : {}),
        ...(input.model !== undefined ? { model: input.model } : {}),
        ...(input.proportionTransform !== undefined
          ? { proportionTransform: input.proportionTransform }
          : {}),
        ...(input.groupLabels !== undefined
          ? { groupLabels: input.groupLabels as Prisma.InputJsonValue }
          : {}),
        outcomeDefinitionId: input.outcomeDefinitionId ?? null,
        order,
        createdById: ctx.userId,
      },
      include: { mappings: true },
    });
    await audit.record(tx, {
      projectId,
      userId: ctx.userId,
      entityType: "AnalysisOutcome",
      entityId: outcome.id,
      action: AuditActions.ANALYSIS_OUTCOME_CREATED,
      newValue: {
        name: outcome.name,
        measure: outcome.measure,
        timepoint: outcome.timepoint,
        direction: outcome.direction,
        model: outcome.model,
        proportionTransform: outcome.proportionTransform,
        outcomeDefinitionId: outcome.outcomeDefinitionId,
      },
    });
    return toRow(outcome);
  });
}

export async function updateOutcome(
  ctx: Ctx,
  projectId: string,
  outcomeId: string,
  input: z.infer<typeof updateOutcomeSchema>,
): Promise<AnalysisOutcomeRow> {
  await requirePermission(ctx, projectId, "analysis.manage");
  return prisma.$transaction(async (tx) => {
    await lockOutcomeForMutation(tx, projectId, outcomeId);
    const outcome = await loadOutcome(tx, projectId, outcomeId);
    if (typeof input.outcomeDefinitionId === "string") {
      await assertOutcomeDefinitionInProject(tx, projectId, input.outcomeDefinitionId);
    }
    const updated = await tx.analysisOutcome.update({
      where: { id: outcomeId },
      data: {
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.timepoint !== undefined ? { timepoint: input.timepoint } : {}),
        ...(input.direction !== undefined ? { direction: input.direction } : {}),
        ...(input.model !== undefined ? { model: input.model } : {}),
        ...(input.proportionTransform !== undefined
          ? { proportionTransform: input.proportionTransform }
          : {}),
        ...(input.groupLabels !== undefined
          ? {
              groupLabels:
                input.groupLabels === null
                  ? Prisma.JsonNull
                  : (input.groupLabels as Prisma.InputJsonValue),
            }
          : {}),
        ...(input.outcomeDefinitionId !== undefined
          ? { outcomeDefinitionId: input.outcomeDefinitionId }
          : {}),
      },
      include: { mappings: true },
    });
    await audit.record(tx, {
      projectId,
      userId: ctx.userId,
      entityType: "AnalysisOutcome",
      entityId: outcomeId,
      action: AuditActions.ANALYSIS_OUTCOME_UPDATED,
      previousValue: {
        name: outcome.name,
        timepoint: outcome.timepoint,
        direction: outcome.direction,
        model: outcome.model,
        proportionTransform: outcome.proportionTransform,
        groupLabels: outcome.groupLabels,
        outcomeDefinitionId: outcome.outcomeDefinitionId,
      },
      newValue: {
        name: updated.name,
        timepoint: updated.timepoint,
        direction: updated.direction,
        model: updated.model,
        proportionTransform: updated.proportionTransform,
        groupLabels: updated.groupLabels,
        outcomeDefinitionId: updated.outcomeDefinitionId,
      },
    });
    return toRow(updated);
  });
}

export async function deleteOutcome(ctx: Ctx, projectId: string, outcomeId: string) {
  await requirePermission(ctx, projectId, "analysis.manage");
  return prisma.$transaction(async (tx) => {
    await lockOutcomeForMutation(tx, projectId, outcomeId);
    const outcome = await loadOutcome(tx, projectId, outcomeId);
    // GRADE children first (suggestions reference runs; ratings reference the assessment).
    await tx.gradeDomainSuggestion.deleteMany({ where: { analysisOutcomeId: outcomeId } });
    await tx.aiGradeRun.deleteMany({ where: { analysisOutcomeId: outcomeId } });
    await tx.gradeDomainRating.deleteMany({
      where: { assessment: { analysisOutcomeId: outcomeId } },
    });
    await tx.gradeAssessment.deleteMany({ where: { analysisOutcomeId: outcomeId } });
    await tx.analysisFieldMap.deleteMany({ where: { analysisOutcomeId: outcomeId } });
    await tx.analysisStudyExclusion.deleteMany({ where: { analysisOutcomeId: outcomeId } });
    await tx.analysisOutcome.delete({ where: { id: outcomeId } });
    await audit.record(tx, {
      projectId,
      userId: ctx.userId,
      entityType: "AnalysisOutcome",
      entityId: outcomeId,
      action: AuditActions.ANALYSIS_OUTCOME_DELETED,
      previousValue: { name: outcome.name, measure: outcome.measure },
    });
    return { deleted: true };
  });
}

// ---------------------------------------------------------------------------
// Mappings (replace-all)
// ---------------------------------------------------------------------------

export async function replaceMappings(
  ctx: Ctx,
  projectId: string,
  outcomeId: string,
  input: z.infer<typeof replaceMappingsSchema>,
): Promise<AnalysisOutcomeRow> {
  await requirePermission(ctx, projectId, "analysis.manage");
  return prisma.$transaction(async (tx) => {
    await lockOutcomeForMutation(tx, projectId, outcomeId);
    const outcome = await loadOutcome(tx, projectId, outcomeId);
    const required = requiredRolesFor(outcome.measure);

    // Every mapped role must be one this measure uses; duplicates would collide on
    // @@unique([analysisOutcomeId, role]) — reject them with a real message instead.
    const seen = new Set<AnalysisRole>();
    for (const mapping of input.mappings) {
      if (!required.includes(mapping.role)) {
        throw validationError(
          `Role ${mapping.role} is not used by measure ${outcome.measure}`,
          { role: mapping.role, allowedRoles: required },
        );
      }
      if (seen.has(mapping.role)) {
        throw validationError(`Role ${mapping.role} is mapped more than once`, {
          role: mapping.role,
        });
      }
      seen.add(mapping.role);
    }

    // R9: every referenced template must belong to this project.
    const templateIds = [...new Set(input.mappings.map((m) => m.templateId))];
    const templates = await tx.extractionTemplate.findMany({
      where: { id: { in: templateIds }, projectId },
      select: { id: true, name: true, status: true, fields: { select: { key: true, type: true } } },
    });
    if (templates.length !== templateIds.length) throw notFound("Extraction template");
    const templateById = new Map(templates.map((t) => [t.id, t]));

    for (const mapping of input.mappings) {
      const template = templateById.get(mapping.templateId)!;
      // Draft fields are still deletable/renamable, which would orphan the mapping
      // (fieldKey has no FK by design). Published/archived fields are immutable.
      if (template.status === "DRAFT") {
        throw validationError(
          `Template "${template.name}" is a draft — publish it before mapping analysis roles to it`,
          { role: mapping.role, templateId: mapping.templateId },
        );
      }
      const field = template.fields.find((f) => f.key === mapping.fieldKey);
      if (!field) {
        throw validationError(
          `Field "${mapping.fieldKey}" does not exist on the mapped template`,
          { role: mapping.role, templateId: mapping.templateId, fieldKey: mapping.fieldKey },
        );
      }
      if (field.type !== "NUMBER") {
        throw validationError(
          `Field "${mapping.fieldKey}" must be a NUMBER field to carry ${mapping.role}`,
          {
            role: mapping.role,
            templateId: mapping.templateId,
            fieldKey: mapping.fieldKey,
            fieldType: field.type,
          },
        );
      }
    }

    // Mapping identity is (templateId, fieldKey) — record both, or a cross-template
    // remap with an identical fieldKey would leave an empty-diff audit event.
    const previous = Object.fromEntries(
      outcome.mappings.map((m) => [m.role, { templateId: m.templateId, fieldKey: m.fieldKey }]),
    );
    const next = Object.fromEntries(
      input.mappings.map((m) => [m.role, { templateId: m.templateId, fieldKey: m.fieldKey }]),
    );

    await tx.analysisFieldMap.deleteMany({ where: { analysisOutcomeId: outcomeId } });
    if (input.mappings.length > 0) {
      await tx.analysisFieldMap.createMany({
        data: input.mappings.map((m) => ({
          analysisOutcomeId: outcomeId,
          role: m.role,
          templateId: m.templateId,
          fieldKey: m.fieldKey,
        })),
      });
    }
    await audit.record(tx, {
      projectId,
      userId: ctx.userId,
      entityType: "AnalysisOutcome",
      entityId: outcomeId,
      action: AuditActions.ANALYSIS_MAPPINGS_REPLACED,
      previousValue: { mappings: previous },
      newValue: { mappings: next },
    });
    const fresh = await tx.analysisOutcome.findFirstOrThrow({
      where: { id: outcomeId },
      include: { mappings: true },
    });
    return toRow(fresh);
  });
}

// ---------------------------------------------------------------------------
// Manual study exclusions (sensitivity valve)
// ---------------------------------------------------------------------------

export async function setStudyExclusion(
  ctx: Ctx,
  projectId: string,
  outcomeId: string,
  studyId: string,
  input: z.infer<typeof setExclusionSchema>,
): Promise<{ excluded: boolean }> {
  await requirePermission(ctx, projectId, "analysis.manage");
  return prisma.$transaction(async (tx) => {
    await lockOutcomeForMutation(tx, projectId, outcomeId);
    await loadOutcome(tx, projectId, outcomeId);
    // R9: the study must belong to this project.
    const study = await tx.study.findFirst({
      where: { id: studyId, projectId },
      select: { id: true, label: true },
    });
    if (!study) throw notFound("Study");

    const existing = await tx.analysisStudyExclusion.findUnique({
      where: { analysisOutcomeId_studyId: { analysisOutcomeId: outcomeId, studyId } },
    });

    if (input.excluded) {
      // Guaranteed by the schema refine; re-checked to narrow the type.
      if (input.reason === undefined) {
        throw validationError("A reason is required when excluding a study");
      }
      await tx.analysisStudyExclusion.upsert({
        where: { analysisOutcomeId_studyId: { analysisOutcomeId: outcomeId, studyId } },
        create: {
          analysisOutcomeId: outcomeId,
          studyId,
          reason: input.reason,
          createdById: ctx.userId,
        },
        update: { reason: input.reason, createdById: ctx.userId },
      });
    } else if (existing) {
      await tx.analysisStudyExclusion.delete({ where: { id: existing.id } });
    }

    await audit.record(tx, {
      projectId,
      userId: ctx.userId,
      entityType: "AnalysisOutcome",
      entityId: outcomeId,
      action: AuditActions.ANALYSIS_STUDY_EXCLUSION_SET,
      previousValue: existing
        ? { excluded: true, reason: existing.reason }
        : { excluded: false },
      newValue: {
        excluded: input.excluded,
        ...(input.excluded ? { reason: input.reason } : {}),
      },
      metadata: { studyId, studyLabel: study.label },
    });
    return { excluded: input.excluded };
  });
}

// ---------------------------------------------------------------------------
// Results
// ---------------------------------------------------------------------------

export type AnalysisRowStatus =
  | "included"
  | "provisional"
  | "disputed"
  | "incomplete"
  | "excluded"
  | "not-pooled";

export interface AnalysisResultRow {
  studyId: string;
  label: string;
  inQuantitativeSynthesis: boolean;
  status: AnalysisRowStatus;
  reason: string | null;
  values: Record<string, { value: number | null; source: NumericSource | null }>;
  effect: StudyEffectResult | null; // stats-lib shape, null unless pooled
}

export interface AnalysisResults {
  outcome: AnalysisOutcomeRow;
  groupLabels: { g1: string; g2: string }; // PROPORTION uses g1 only (the cohort)
  rows: AnalysisResultRow[];
  pooled: { fixed: PooledEstimate | null; random: PooledEstimate | null };
  heterogeneity: Heterogeneity | null;
  predictionInterval: PredictionInterval | null; // random effects, k >= 3
  egger: EggerResult | null; // k >= 3
  scale: AnalysisScale;
  nullValue: number | null; // null for PROPORTION (no meaningful null line)
  displayMeta: DisplayMeta; // back-transform metadata (FT harmonic mean etc.)
  // False for callers under the extraction blind and for internal final-only computations —
  // the server then ignores provisional input and withholds SINGLE values / dispute detail.
  provisionalAllowed: boolean;
}

export async function computeOutcomeResults(
  ctx: Ctx,
  projectId: string,
  outcomeId: string,
  query: {
    includeProvisional?: boolean;
    // Internal shared-output mode (GRADE/SoF): resolve only caller-independent final data.
    // API routes never forward this flag from request input.
    finalOnly?: boolean;
  } = {},
  db: Tx = prisma,
): Promise<AnalysisResults> {
  const member = await requirePermission(ctx, projectId, "analysis.view");
  // R1 blind mirror (same rule as listForms/getExtractionMatrix): only
  // extraction.adjudicate or project.edit holders may see pre-consensus extraction
  // data — provisional values, lone-extractor SINGLE values while co-extraction is
  // open, and the existence of extraction disagreements.
  const requesterCanSeeAll =
    can(member.roles, "extraction.adjudicate") || can(member.roles, "project.edit");
  const finalOnly = query.finalOnly === true;
  // Shared persisted outputs must never depend on which authorized caller generated them.
  // Reuse the blind resolver's withholding rule even for OWNER/ADMIN in final-only mode.
  const seePreConsensus = requesterCanSeeAll && !finalOnly;
  const outcome = await loadOutcome(db, projectId, outcomeId);
  const measure = outcome.measure as EffectMeasureId;
  const required = requiredRolesFor(outcome.measure);
  const includeProvisional = query.includeProvisional === true && seePreConsensus;

  const [studies, exclusions] = await Promise.all([
    db.study.findMany({
      where: { projectId },
      orderBy: [{ label: "asc" }, { id: "asc" }],
      select: { id: true, label: true, inQuantitativeSynthesis: true },
    }),
    db.analysisStudyExclusion.findMany({ where: { analysisOutcomeId: outcomeId } }),
  ]);
  const exclusionByStudy = new Map(exclusions.map((e) => [e.studyId, e]));

  // Manual exclusions short-circuit before resolution — don't even fetch their values.
  const resolvable = studies.filter((s) => !exclusionByStudy.has(s.id));
  const resolved = await fetchResolvedRoleValues({
    projectId,
    studyIds: resolvable.map((s) => s.id),
    mappings: outcome.mappings,
    includeProvisional,
    blinded: !seePreConsensus,
    db,
  });

  const rows: AnalysisResultRow[] = [];
  const candidateRows = new Map<string, AnalysisResultRow>();
  const inputs: StudyEffectInput[] = [];
  const mappedRoles = new Set(outcome.mappings.map((m) => m.role));

  for (const study of studies) {
    const base = {
      studyId: study.id,
      label: study.label,
      inQuantitativeSynthesis: study.inQuantitativeSynthesis,
    };
    const exclusion = exclusionByStudy.get(study.id);
    if (exclusion) {
      rows.push({ ...base, status: "excluded", reason: exclusion.reason, values: {}, effect: null });
      continue;
    }

    const roleValues = resolved.get(study.id) ?? {};
    const values: AnalysisResultRow["values"] = {};
    const disputedRoles: AnalysisRole[] = [];
    let missingRoles: AnalysisRole[] = [];
    let provisional = false;
    for (const role of required) {
      const r = roleValues[role] ?? { value: null, source: null, disputed: false };
      values[role] = { value: r.value, source: r.source };
      if (r.disputed) disputedRoles.push(role);
      else if (r.value === null) missingRoles.push(role);
      if (r.source === "PROVISIONAL") provisional = true;
    }

    // GENERIC_IV completeness is se-source aware: the estimate plus EITHER a standard
    // error OR both CI bounds. A study missing its se-source lands "incomplete"; a
    // present-but-invalid combination (e.g. estimate outside its CI) goes through to
    // the stats engine, which rejects it with a reason ("not-pooled").
    if (measure === "GENERIC_IV" && disputedRoles.length === 0) {
      const val = (role: AnalysisRole) => values[role]?.value ?? null;
      missingRoles = [];
      if (val("EFFECT_ESTIMATE") === null) missingRoles.push("EFFECT_ESTIMATE");
      const seOk = val("EFFECT_SE") !== null;
      const ciOk = val("EFFECT_CI_LOW") !== null && val("EFFECT_CI_UP") !== null;
      if (!seOk && !ciOk) {
        // Name the mapped roles that could still complete the row.
        const sources: AnalysisRole[] = [];
        if (mappedRoles.has("EFFECT_SE")) sources.push("EFFECT_SE");
        if (mappedRoles.has("EFFECT_CI_LOW") && val("EFFECT_CI_LOW") === null) {
          sources.push("EFFECT_CI_LOW");
        }
        if (mappedRoles.has("EFFECT_CI_UP") && val("EFFECT_CI_UP") === null) {
          sources.push("EFFECT_CI_UP");
        }
        missingRoles.push(...(sources.length > 0 ? sources : (["EFFECT_SE"] as AnalysisRole[])));
      }
    }

    if (disputedRoles.length > 0) {
      // Blinded callers must not learn that extractors disagree (the matrix hides
      // conflicts from them too) — present the row as generically unfinished.
      rows.push({
        ...base,
        status: seePreConsensus ? "disputed" : "incomplete",
        reason: seePreConsensus
          ? `Unresolved extraction disagreement for ${disputedRoles.join(", ")}`
          : `Extraction not finalized for ${disputedRoles.join(", ")}`,
        values,
        effect: null,
      });
      continue;
    }
    if (missingRoles.length > 0) {
      rows.push({
        ...base,
        status: "incomplete",
        reason: `Missing values for ${missingRoles.join(", ")}`,
        values,
        effect: null,
      });
      continue;
    }

    // All needed roles resolved to finite numbers — a pooling candidate. Statistical
    // validity (events <= totals, sd > 0, CI ordering, ...) is the engine's job, not
    // pre-validated here.
    const num = (role: AnalysisRole): number => values[role]!.value!;
    const numOrNull = (role: AnalysisRole): number | null => values[role]?.value ?? null;
    let data: StudyData;
    if (measure === "MD" || measure === "SMD") {
      data = {
        kind: "continuous",
        stats: {
          m1: num("G1_MEAN"),
          sd1: num("G1_SD"),
          n1: num("G1_N"),
          m2: num("G2_MEAN"),
          sd2: num("G2_SD"),
          n2: num("G2_N"),
        },
      };
    } else if (measure === "PROPORTION") {
      data = { kind: "proportion", counts: { e: num("G1_EVENTS"), n: num("G1_TOTAL") } };
    } else if (measure === "GENERIC_IV") {
      // The engine prefers a present SE and otherwise derives it from the CI bounds.
      data = {
        kind: "generic",
        stats: {
          y: num("EFFECT_ESTIMATE"),
          se: numOrNull("EFFECT_SE"),
          ciLow: numOrNull("EFFECT_CI_LOW"),
          ciUp: numOrNull("EFFECT_CI_UP"),
        },
      };
    } else {
      data = {
        kind: "binary",
        counts: {
          e1: num("G1_EVENTS"),
          n1: num("G1_TOTAL"),
          e2: num("G2_EVENTS"),
          n2: num("G2_TOTAL"),
        },
      };
    }
    inputs.push({ id: study.id, label: study.label, data });
    const row: AnalysisResultRow = {
      ...base,
      status: provisional ? "provisional" : "included",
      reason: null,
      values,
      effect: null,
    };
    rows.push(row);
    candidateRows.set(study.id, row);
  }

  const meta = computeMeta(inputs, {
    measure,
    proportionTransform: outcome.proportionTransform,
  });
  const effectById = new Map(meta.studies.map((s) => [s.id, s]));
  const rejectedById = new Map(meta.excluded.map((s) => [s.id, s]));
  for (const [studyId, row] of candidateRows) {
    const effect = effectById.get(studyId);
    if (effect) {
      row.effect = effect;
      continue;
    }
    row.status = "not-pooled";
    row.reason = rejectedById.get(studyId)?.reason ?? "Not pooled by the stats engine";
  }

  const labels = parseGroupLabels(outcome.groupLabels);
  return {
    outcome: toRow(outcome),
    // PROPORTION has one group — g1 labels the cohort, g2 is unused by its UI.
    groupLabels: {
      g1: labels?.g1 ?? (measure === "PROPORTION" ? "Cohort" : "Group 1"),
      g2: labels?.g2 ?? "Group 2",
    },
    rows,
    pooled: { fixed: meta.fixed, random: meta.random },
    heterogeneity: meta.heterogeneity,
    predictionInterval: meta.predictionInterval,
    egger: meta.egger,
    scale: meta.scale,
    nullValue: meta.nullValue,
    displayMeta: meta.displayMeta,
    provisionalAllowed: seePreConsensus,
  };
}
