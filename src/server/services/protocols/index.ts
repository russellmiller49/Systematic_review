// Protocol builder, versions, amendments, exclusion reasons.
//
// THE AMENDMENT RULE (docs/01 integrity rule 3, docs/09): once screening has begun
// (any ScreeningDecision exists for any stage of the project), every change to the protocol
// or its children (PICO / criteria / outcomes) requires an `amendmentReason`. The change,
// the new ProtocolVersion (snapshot AFTER the change), the ProtocolAmendment row, and the
// audit events are all written in ONE transaction.

import { z, type ZodSchema } from "zod";
import type {
  Prisma,
  Protocol,
  ProtocolAmendment,
  ProtocolVersion,
  ReasonStage,
} from "@prisma/client";
import { prisma, type Tx } from "@/server/db";
import { conflict, invalidState, notFound, validationError } from "@/server/errors";
import type { Ctx } from "@/server/auth/session";
import { requirePermission } from "@/server/permissions";
import * as audit from "@/server/services/audit";
import { AuditActions } from "@/server/services/audit";

// ---------------------------------------------------------------------------
// Zod schemas (exported for route handlers)
// ---------------------------------------------------------------------------

const optionalText = (max: number) => z.string().trim().max(max).nullable().optional();
const stringList = z.array(z.string().trim().min(1).max(500)).max(200).optional();
const yearField = z.number().int().min(1000).max(9999).nullable().optional();

const amendmentFields = {
  amendmentReason: z.string().trim().min(3).max(2000).optional(),
  amendmentDescription: z.string().trim().max(5000).optional(),
};

export const updateProtocolSchema = z.object({
  background: optionalText(50_000),
  reviewQuestion: optionalText(10_000),
  population: optionalText(10_000),
  intervention: optionalText(10_000),
  comparator: optionalText(10_000),
  outcomesNarrative: optionalText(20_000),
  studyDesigns: stringList,
  setting: optionalText(10_000),
  dateRestrictionFrom: yearField,
  dateRestrictionTo: yearField,
  languageRestrictions: stringList,
  databases: stringList,
  grayLiteratureSources: stringList,
  searchStrategyNotes: optionalText(20_000),
  subgroupAnalysisPlan: optionalText(20_000),
  sensitivityAnalysisPlan: optionalText(20_000),
  metaAnalysisPlan: optionalText(20_000),
  gradePlan: optionalText(20_000),
  ...amendmentFields,
});
export type UpdateProtocolInput = z.infer<typeof updateProtocolSchema>;

export const createPicoSchema = z.object({
  question: z.string().trim().min(1).max(2000),
  population: optionalText(2000),
  intervention: optionalText(2000),
  comparator: optionalText(2000),
  outcome: optionalText(2000),
  order: z.number().int().min(0).optional(),
  ...amendmentFields,
});
export const updatePicoSchema = createPicoSchema.partial();
export type CreatePicoInput = z.infer<typeof createPicoSchema>;
export type UpdatePicoInput = z.infer<typeof updatePicoSchema>;

export const createCriterionSchema = z.object({
  type: z.enum(["INCLUSION", "EXCLUSION"]),
  category: optionalText(200),
  text: z.string().trim().min(1).max(5000),
  order: z.number().int().min(0).optional(),
  ...amendmentFields,
});
export const updateCriterionSchema = createCriterionSchema.partial();
export type CreateCriterionInput = z.infer<typeof createCriterionSchema>;
export type UpdateCriterionInput = z.infer<typeof updateCriterionSchema>;

export const createOutcomeSchema = z.object({
  name: z.string().trim().min(1).max(500),
  type: z.enum(["PRIMARY", "SECONDARY"]).optional(),
  measure: optionalText(200),
  timepoint: optionalText(200),
  order: z.number().int().min(0).optional(),
  ...amendmentFields,
});
export const updateOutcomeSchema = createOutcomeSchema.partial();
export type CreateOutcomeInput = z.infer<typeof createOutcomeSchema>;
export type UpdateOutcomeInput = z.infer<typeof updateOutcomeSchema>;

// DELETE bodies are optional — only needed once screening has begun.
export const amendmentOnlySchema = z.object({ ...amendmentFields });
export type AmendmentOnlyInput = z.infer<typeof amendmentOnlySchema>;

const reasonStageEnum = z.enum(["TITLE_ABSTRACT", "FULL_TEXT", "BOTH"]);

export const createExclusionReasonSchema = z.object({
  label: z.string().trim().min(1).max(300),
  stage: reasonStageEnum.optional(),
  order: z.number().int().min(0).optional(),
});
export const updateExclusionReasonSchema = z.object({
  label: z.string().trim().min(1).max(300).optional(),
  stage: reasonStageEnum.optional(),
  order: z.number().int().min(0).optional(),
  isActive: z.boolean().optional(),
});
export const listExclusionReasonsQuerySchema = z.object({
  stage: reasonStageEnum.optional(),
  includeInactive: z
    .enum(["true", "false"])
    .optional()
    .transform((v) => v === "true"),
});
export type CreateExclusionReasonInput = z.infer<typeof createExclusionReasonSchema>;
export type UpdateExclusionReasonInput = z.infer<typeof updateExclusionReasonSchema>;
export type ListExclusionReasonsQuery = z.output<typeof listExclusionReasonsQuerySchema>;

// Like parseBody, but tolerates an empty body (DELETE requests usually have none).
export async function parseOptionalBody<T>(req: Request, schema: ZodSchema<T>): Promise<T> {
  const text = await req.text();
  if (!text.trim()) return schema.parse({});
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw validationError("Request body must be valid JSON");
  }
  return schema.parse(json);
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

// Protocol is 1:1 with project and created lazily (project creation may or may not seed it).
async function ensureProtocol(tx: Tx, projectId: string): Promise<Protocol> {
  return tx.protocol.upsert({ where: { projectId }, create: { projectId }, update: {} });
}

// Integrity rule 3 predicate: has ANY screening decision been recorded for this project?
async function screeningHasBegun(tx: Tx, projectId: string): Promise<boolean> {
  const decision = await tx.screeningDecision.findFirst({
    where: { stage: { projectId } },
    select: { id: true },
  });
  return decision !== null;
}

// Throws 422 when screening has begun and no amendmentReason was supplied.
async function checkAmendmentGate(
  tx: Tx,
  projectId: string,
  amendmentReason: string | undefined,
): Promise<boolean> {
  const begun = await screeningHasBegun(tx, projectId);
  if (begun && !amendmentReason) {
    throw invalidState(
      "Screening has begun for this project — protocol changes require an amendmentReason",
    );
  }
  return begun;
}

// Full snapshot: protocol + children + stage configs + exclusion reasons (superset used for
// both publish and amendment versions).
async function buildSnapshot(
  tx: Tx,
  projectId: string,
  protocolId: string,
): Promise<Prisma.InputJsonValue> {
  const protocol = await tx.protocol.findUniqueOrThrow({
    where: { id: protocolId },
    include: {
      picoQuestions: { orderBy: { order: "asc" } },
      criteria: { orderBy: [{ type: "asc" }, { order: "asc" }] },
      outcomes: { orderBy: { order: "asc" } },
    },
  });
  const screeningStages = await tx.screeningStage.findMany({
    where: { projectId },
    orderBy: { type: "asc" },
  });
  const exclusionReasons = await tx.exclusionReason.findMany({
    where: { projectId },
    orderBy: [{ order: "asc" }, { createdAt: "asc" }],
  });
  // Round-trip strips Dates into JSON-safe values.
  return JSON.parse(
    JSON.stringify({ protocol, screeningStages, exclusionReasons }),
  ) as Prisma.InputJsonValue;
}

async function lastVersionNumber(tx: Tx, protocolId: string): Promise<number> {
  const last = await tx.protocolVersion.findFirst({
    where: { protocolId },
    orderBy: { versionNumber: "desc" },
    select: { versionNumber: true },
  });
  return last?.versionNumber ?? 0;
}

// The amendment bundle: new version (snapshot AFTER the change) + amendment row + audit,
// all on the caller's transaction.
async function createAmendedVersion(
  tx: Tx,
  ctx: Ctx,
  projectId: string,
  protocolId: string,
  reason: string,
  description: string | undefined,
): Promise<{ version: ProtocolVersion; amendment: ProtocolAmendment }> {
  const from = await lastVersionNumber(tx, protocolId);
  const to = from + 1;
  const snapshot = await buildSnapshot(tx, projectId, protocolId);
  const version = await tx.protocolVersion.create({
    data: { protocolId, versionNumber: to, snapshot, createdById: ctx.userId },
  });
  const amendment = await tx.protocolAmendment.create({
    data: {
      protocolId,
      fromVersion: from,
      toVersion: to,
      reason,
      description: description ?? null,
      createdById: ctx.userId,
    },
  });
  await audit.record(tx, {
    projectId,
    userId: ctx.userId,
    entityType: "ProtocolAmendment",
    entityId: amendment.id,
    action: AuditActions.PROTOCOL_AMENDED,
    reason,
    newValue: { fromVersion: from, toVersion: to, description: amendment.description },
    metadata: { versionId: version.id },
  });
  return { version, amendment };
}

// ---------------------------------------------------------------------------
// Protocol read / update / publish
// ---------------------------------------------------------------------------

const PROTOCOL_FIELDS = [
  "background",
  "reviewQuestion",
  "population",
  "intervention",
  "comparator",
  "outcomesNarrative",
  "studyDesigns",
  "setting",
  "dateRestrictionFrom",
  "dateRestrictionTo",
  "languageRestrictions",
  "databases",
  "grayLiteratureSources",
  "searchStrategyNotes",
  "subgroupAnalysisPlan",
  "sensitivityAnalysisPlan",
  "metaAnalysisPlan",
  "gradePlan",
] as const;
type ProtocolFieldKey = (typeof PROTOCOL_FIELDS)[number];

// Field-level diff: only keys actually provided AND changed make it into the update payload
// and the audit previous/new values.
function diffProtocolInput(before: Protocol, input: UpdateProtocolInput) {
  const data: Record<string, unknown> = {};
  const previous: Record<string, unknown> = {};
  const next: Record<string, unknown> = {};
  for (const key of PROTOCOL_FIELDS) {
    const value = input[key as ProtocolFieldKey];
    if (value === undefined) continue;
    const prior = before[key];
    if (JSON.stringify(prior ?? null) !== JSON.stringify(value ?? null)) {
      data[key] = value;
      previous[key] = prior ?? null;
      next[key] = value ?? null;
    }
  }
  return { data: data as Prisma.ProtocolUncheckedUpdateInput, previous, next };
}

export async function getProtocol(ctx: Ctx, projectId: string) {
  await requirePermission(ctx, projectId, "project.view");
  const base = await ensureProtocol(prisma, projectId);
  const protocol = await prisma.protocol.findUniqueOrThrow({
    where: { id: base.id },
    include: {
      picoQuestions: { orderBy: { order: "asc" } },
      criteria: { orderBy: [{ type: "asc" }, { order: "asc" }] },
      outcomes: { orderBy: { order: "asc" } },
    },
  });
  const latestVersionNumber = await lastVersionNumber(prisma, protocol.id);
  return { ...protocol, latestVersionNumber };
}

export async function updateProtocol(ctx: Ctx, projectId: string, input: UpdateProtocolInput) {
  await requirePermission(ctx, projectId, "protocol.edit");
  return prisma.$transaction(async (tx) => {
    const before = await ensureProtocol(tx, projectId);
    const begun = await checkAmendmentGate(tx, projectId, input.amendmentReason);
    const { data, previous, next } = diffProtocolInput(before, input);
    if (Object.keys(next).length === 0) {
      return { protocol: before, version: null, amendment: null };
    }
    const protocol = await tx.protocol.update({ where: { id: before.id }, data });
    await audit.record(tx, {
      projectId,
      userId: ctx.userId,
      entityType: "Protocol",
      entityId: protocol.id,
      action: AuditActions.PROTOCOL_UPDATED,
      previousValue: previous,
      newValue: next,
      reason: input.amendmentReason ?? null,
    });
    let version: ProtocolVersion | null = null;
    let amendment: ProtocolAmendment | null = null;
    if (begun) {
      // amendmentReason presence guaranteed by checkAmendmentGate
      const bundle = await createAmendedVersion(
        tx,
        ctx,
        projectId,
        protocol.id,
        input.amendmentReason as string,
        input.amendmentDescription,
      );
      version = bundle.version;
      amendment = bundle.amendment;
    }
    return { protocol, version, amendment };
  });
}

// Freezes the current protocol (incl. stage configs + exclusion reasons) as the next version.
// Version 1 on first publish.
export async function publishProtocol(ctx: Ctx, projectId: string) {
  await requirePermission(ctx, projectId, "protocol.edit");
  return prisma.$transaction(async (tx) => {
    const protocol = await ensureProtocol(tx, projectId);
    const versionNumber = (await lastVersionNumber(tx, protocol.id)) + 1;
    const snapshot = await buildSnapshot(tx, projectId, protocol.id);
    const version = await tx.protocolVersion.create({
      data: { protocolId: protocol.id, versionNumber, snapshot, createdById: ctx.userId },
    });
    await audit.record(tx, {
      projectId,
      userId: ctx.userId,
      entityType: "ProtocolVersion",
      entityId: version.id,
      action: AuditActions.PROTOCOL_PUBLISHED,
      newValue: { versionNumber },
    });
    return version;
  });
}

export async function listVersions(ctx: Ctx, projectId: string) {
  await requirePermission(ctx, projectId, "project.view");
  return prisma.protocolVersion.findMany({
    where: { protocol: { projectId } },
    orderBy: { versionNumber: "desc" },
    select: {
      id: true,
      versionNumber: true,
      snapshot: true,
      createdAt: true,
      createdBy: { select: { id: true, name: true, email: true } },
    },
  });
}

export async function listAmendments(ctx: Ctx, projectId: string) {
  await requirePermission(ctx, projectId, "project.view");
  return prisma.protocolAmendment.findMany({
    where: { protocol: { projectId } },
    orderBy: { createdAt: "desc" },
    include: { createdBy: { select: { id: true, name: true, email: true } } },
  });
}

// ---------------------------------------------------------------------------
// PICO questions
// ---------------------------------------------------------------------------

const picoFields = (row: {
  question: string;
  population: string | null;
  intervention: string | null;
  comparator: string | null;
  outcome: string | null;
  order: number;
}) => ({
  question: row.question,
  population: row.population,
  intervention: row.intervention,
  comparator: row.comparator,
  outcome: row.outcome,
  order: row.order,
});

export async function createPico(ctx: Ctx, projectId: string, input: CreatePicoInput) {
  await requirePermission(ctx, projectId, "protocol.edit");
  return prisma.$transaction(async (tx) => {
    const protocol = await ensureProtocol(tx, projectId);
    const begun = await checkAmendmentGate(tx, projectId, input.amendmentReason);
    const pico = await tx.pICOQuestion.create({
      data: {
        protocolId: protocol.id,
        question: input.question,
        population: input.population ?? null,
        intervention: input.intervention ?? null,
        comparator: input.comparator ?? null,
        outcome: input.outcome ?? null,
        order: input.order ?? 0,
      },
    });
    await audit.record(tx, {
      projectId,
      userId: ctx.userId,
      entityType: "PICOQuestion",
      entityId: pico.id,
      action: AuditActions.PICO_CREATED,
      newValue: picoFields(pico),
      reason: input.amendmentReason ?? null,
    });
    if (begun) {
      await createAmendedVersion(
        tx,
        ctx,
        projectId,
        protocol.id,
        input.amendmentReason as string,
        input.amendmentDescription,
      );
    }
    return pico;
  });
}

export async function updatePico(
  ctx: Ctx,
  projectId: string,
  picoId: string,
  input: UpdatePicoInput,
) {
  await requirePermission(ctx, projectId, "protocol.edit");
  return prisma.$transaction(async (tx) => {
    const before = await tx.pICOQuestion.findFirst({
      where: { id: picoId, protocol: { projectId } },
    });
    if (!before) throw notFound("PICO question");
    const begun = await checkAmendmentGate(tx, projectId, input.amendmentReason);
    const data: Prisma.PICOQuestionUncheckedUpdateInput = {};
    if (input.question !== undefined) data.question = input.question;
    if (input.population !== undefined) data.population = input.population;
    if (input.intervention !== undefined) data.intervention = input.intervention;
    if (input.comparator !== undefined) data.comparator = input.comparator;
    if (input.outcome !== undefined) data.outcome = input.outcome;
    if (input.order !== undefined) data.order = input.order;
    const pico = await tx.pICOQuestion.update({ where: { id: before.id }, data });
    await audit.record(tx, {
      projectId,
      userId: ctx.userId,
      entityType: "PICOQuestion",
      entityId: pico.id,
      action: AuditActions.PICO_UPDATED,
      previousValue: picoFields(before),
      newValue: picoFields(pico),
      reason: input.amendmentReason ?? null,
    });
    if (begun) {
      await createAmendedVersion(
        tx,
        ctx,
        projectId,
        before.protocolId,
        input.amendmentReason as string,
        input.amendmentDescription,
      );
    }
    return pico;
  });
}

export async function deletePico(
  ctx: Ctx,
  projectId: string,
  picoId: string,
  input: AmendmentOnlyInput,
) {
  await requirePermission(ctx, projectId, "protocol.edit");
  return prisma.$transaction(async (tx) => {
    const before = await tx.pICOQuestion.findFirst({
      where: { id: picoId, protocol: { projectId } },
    });
    if (!before) throw notFound("PICO question");
    const begun = await checkAmendmentGate(tx, projectId, input.amendmentReason);
    await tx.pICOQuestion.delete({ where: { id: before.id } });
    await audit.record(tx, {
      projectId,
      userId: ctx.userId,
      entityType: "PICOQuestion",
      entityId: before.id,
      action: AuditActions.PICO_DELETED,
      previousValue: picoFields(before),
      reason: input.amendmentReason ?? null,
    });
    if (begun) {
      await createAmendedVersion(
        tx,
        ctx,
        projectId,
        before.protocolId,
        input.amendmentReason as string,
        input.amendmentDescription,
      );
    }
    return { id: before.id };
  });
}

// ---------------------------------------------------------------------------
// Eligibility criteria
// ---------------------------------------------------------------------------

const criterionFields = (row: {
  type: "INCLUSION" | "EXCLUSION";
  category: string | null;
  text: string;
  order: number;
}) => ({ type: row.type, category: row.category, text: row.text, order: row.order });

export async function createCriterion(ctx: Ctx, projectId: string, input: CreateCriterionInput) {
  await requirePermission(ctx, projectId, "protocol.edit");
  return prisma.$transaction(async (tx) => {
    const protocol = await ensureProtocol(tx, projectId);
    const begun = await checkAmendmentGate(tx, projectId, input.amendmentReason);
    const criterion = await tx.eligibilityCriterion.create({
      data: {
        protocolId: protocol.id,
        type: input.type,
        category: input.category ?? null,
        text: input.text,
        order: input.order ?? 0,
      },
    });
    await audit.record(tx, {
      projectId,
      userId: ctx.userId,
      entityType: "EligibilityCriterion",
      entityId: criterion.id,
      action: AuditActions.CRITERION_CREATED,
      newValue: criterionFields(criterion),
      reason: input.amendmentReason ?? null,
    });
    if (begun) {
      await createAmendedVersion(
        tx,
        ctx,
        projectId,
        protocol.id,
        input.amendmentReason as string,
        input.amendmentDescription,
      );
    }
    return criterion;
  });
}

export async function updateCriterion(
  ctx: Ctx,
  projectId: string,
  criterionId: string,
  input: UpdateCriterionInput,
) {
  await requirePermission(ctx, projectId, "protocol.edit");
  return prisma.$transaction(async (tx) => {
    const before = await tx.eligibilityCriterion.findFirst({
      where: { id: criterionId, protocol: { projectId } },
    });
    if (!before) throw notFound("Eligibility criterion");
    const begun = await checkAmendmentGate(tx, projectId, input.amendmentReason);
    const data: Prisma.EligibilityCriterionUncheckedUpdateInput = {};
    if (input.type !== undefined) data.type = input.type;
    if (input.category !== undefined) data.category = input.category;
    if (input.text !== undefined) data.text = input.text;
    if (input.order !== undefined) data.order = input.order;
    const criterion = await tx.eligibilityCriterion.update({ where: { id: before.id }, data });
    await audit.record(tx, {
      projectId,
      userId: ctx.userId,
      entityType: "EligibilityCriterion",
      entityId: criterion.id,
      action: AuditActions.CRITERION_UPDATED,
      previousValue: criterionFields(before),
      newValue: criterionFields(criterion),
      reason: input.amendmentReason ?? null,
    });
    if (begun) {
      await createAmendedVersion(
        tx,
        ctx,
        projectId,
        before.protocolId,
        input.amendmentReason as string,
        input.amendmentDescription,
      );
    }
    return criterion;
  });
}

export async function deleteCriterion(
  ctx: Ctx,
  projectId: string,
  criterionId: string,
  input: AmendmentOnlyInput,
) {
  await requirePermission(ctx, projectId, "protocol.edit");
  return prisma.$transaction(async (tx) => {
    const before = await tx.eligibilityCriterion.findFirst({
      where: { id: criterionId, protocol: { projectId } },
    });
    if (!before) throw notFound("Eligibility criterion");
    const begun = await checkAmendmentGate(tx, projectId, input.amendmentReason);
    await tx.eligibilityCriterion.delete({ where: { id: before.id } });
    await audit.record(tx, {
      projectId,
      userId: ctx.userId,
      entityType: "EligibilityCriterion",
      entityId: before.id,
      action: AuditActions.CRITERION_DELETED,
      previousValue: criterionFields(before),
      reason: input.amendmentReason ?? null,
    });
    if (begun) {
      await createAmendedVersion(
        tx,
        ctx,
        projectId,
        before.protocolId,
        input.amendmentReason as string,
        input.amendmentDescription,
      );
    }
    return { id: before.id };
  });
}

// ---------------------------------------------------------------------------
// Outcome definitions
// ---------------------------------------------------------------------------

const outcomeFields = (row: {
  name: string;
  type: "PRIMARY" | "SECONDARY";
  measure: string | null;
  timepoint: string | null;
  order: number;
}) => ({
  name: row.name,
  type: row.type,
  measure: row.measure,
  timepoint: row.timepoint,
  order: row.order,
});

export async function createOutcome(ctx: Ctx, projectId: string, input: CreateOutcomeInput) {
  await requirePermission(ctx, projectId, "protocol.edit");
  return prisma.$transaction(async (tx) => {
    const protocol = await ensureProtocol(tx, projectId);
    const begun = await checkAmendmentGate(tx, projectId, input.amendmentReason);
    const outcome = await tx.outcomeDefinition.create({
      data: {
        protocolId: protocol.id,
        name: input.name,
        type: input.type ?? "PRIMARY",
        measure: input.measure ?? null,
        timepoint: input.timepoint ?? null,
        order: input.order ?? 0,
      },
    });
    await audit.record(tx, {
      projectId,
      userId: ctx.userId,
      entityType: "OutcomeDefinition",
      entityId: outcome.id,
      action: AuditActions.OUTCOME_CREATED,
      newValue: outcomeFields(outcome),
      reason: input.amendmentReason ?? null,
    });
    if (begun) {
      await createAmendedVersion(
        tx,
        ctx,
        projectId,
        protocol.id,
        input.amendmentReason as string,
        input.amendmentDescription,
      );
    }
    return outcome;
  });
}

export async function updateOutcome(
  ctx: Ctx,
  projectId: string,
  outcomeId: string,
  input: UpdateOutcomeInput,
) {
  await requirePermission(ctx, projectId, "protocol.edit");
  return prisma.$transaction(async (tx) => {
    const before = await tx.outcomeDefinition.findFirst({
      where: { id: outcomeId, protocol: { projectId } },
    });
    if (!before) throw notFound("Outcome definition");
    const begun = await checkAmendmentGate(tx, projectId, input.amendmentReason);
    const data: Prisma.OutcomeDefinitionUncheckedUpdateInput = {};
    if (input.name !== undefined) data.name = input.name;
    if (input.type !== undefined) data.type = input.type;
    if (input.measure !== undefined) data.measure = input.measure;
    if (input.timepoint !== undefined) data.timepoint = input.timepoint;
    if (input.order !== undefined) data.order = input.order;
    const outcome = await tx.outcomeDefinition.update({ where: { id: before.id }, data });
    await audit.record(tx, {
      projectId,
      userId: ctx.userId,
      entityType: "OutcomeDefinition",
      entityId: outcome.id,
      action: AuditActions.OUTCOME_UPDATED,
      previousValue: outcomeFields(before),
      newValue: outcomeFields(outcome),
      reason: input.amendmentReason ?? null,
    });
    if (begun) {
      await createAmendedVersion(
        tx,
        ctx,
        projectId,
        before.protocolId,
        input.amendmentReason as string,
        input.amendmentDescription,
      );
    }
    return outcome;
  });
}

export async function deleteOutcome(
  ctx: Ctx,
  projectId: string,
  outcomeId: string,
  input: AmendmentOnlyInput,
) {
  await requirePermission(ctx, projectId, "protocol.edit");
  return prisma.$transaction(async (tx) => {
    const before = await tx.outcomeDefinition.findFirst({
      where: { id: outcomeId, protocol: { projectId } },
    });
    if (!before) throw notFound("Outcome definition");
    const begun = await checkAmendmentGate(tx, projectId, input.amendmentReason);
    await tx.outcomeDefinition.delete({ where: { id: before.id } });
    await audit.record(tx, {
      projectId,
      userId: ctx.userId,
      entityType: "OutcomeDefinition",
      entityId: before.id,
      action: AuditActions.OUTCOME_DELETED,
      previousValue: outcomeFields(before),
      reason: input.amendmentReason ?? null,
    });
    if (begun) {
      await createAmendedVersion(
        tx,
        ctx,
        projectId,
        before.protocolId,
        input.amendmentReason as string,
        input.amendmentDescription,
      );
    }
    return { id: before.id };
  });
}

// ---------------------------------------------------------------------------
// Exclusion reasons (project-scoped; NOT under the amendment rule)
// ---------------------------------------------------------------------------

const exclusionReasonFields = (row: {
  label: string;
  stage: ReasonStage;
  order: number;
  isActive: boolean;
}) => ({ label: row.label, stage: row.stage, order: row.order, isActive: row.isActive });

export async function listExclusionReasons(
  ctx: Ctx,
  projectId: string,
  query: ListExclusionReasonsQuery,
) {
  await requirePermission(ctx, projectId, "project.view");
  const where: Prisma.ExclusionReasonWhereInput = { projectId };
  if (!query.includeInactive) where.isActive = true;
  if (query.stage) {
    // A stage filter returns the reasons APPLICABLE at that stage (stage-specific + BOTH).
    where.stage = query.stage === "BOTH" ? "BOTH" : { in: [query.stage, "BOTH"] };
  }
  return prisma.exclusionReason.findMany({
    where,
    orderBy: [{ order: "asc" }, { createdAt: "asc" }],
  });
}

export async function createExclusionReason(
  ctx: Ctx,
  projectId: string,
  input: CreateExclusionReasonInput,
) {
  await requirePermission(ctx, projectId, "protocol.edit");
  return prisma.$transaction(async (tx) => {
    const existing = await tx.exclusionReason.findUnique({
      where: { projectId_label: { projectId, label: input.label } },
    });
    if (existing) throw conflict("An exclusion reason with this label already exists");
    const reason = await tx.exclusionReason.create({
      data: {
        projectId,
        label: input.label,
        stage: input.stage ?? "BOTH",
        order: input.order ?? 0,
      },
    });
    await audit.record(tx, {
      projectId,
      userId: ctx.userId,
      entityType: "ExclusionReason",
      entityId: reason.id,
      action: AuditActions.EXCLUSION_REASON_CREATED,
      newValue: exclusionReasonFields(reason),
    });
    return reason;
  });
}

export async function updateExclusionReason(
  ctx: Ctx,
  projectId: string,
  reasonId: string,
  input: UpdateExclusionReasonInput,
) {
  await requirePermission(ctx, projectId, "protocol.edit");
  return prisma.$transaction(async (tx) => {
    const before = await tx.exclusionReason.findFirst({ where: { id: reasonId, projectId } });
    if (!before) throw notFound("Exclusion reason");
    if (input.label !== undefined && input.label !== before.label) {
      const clash = await tx.exclusionReason.findUnique({
        where: { projectId_label: { projectId, label: input.label } },
      });
      if (clash) throw conflict("An exclusion reason with this label already exists");
    }
    const data: Prisma.ExclusionReasonUncheckedUpdateInput = {};
    if (input.label !== undefined) data.label = input.label;
    if (input.stage !== undefined) data.stage = input.stage;
    if (input.order !== undefined) data.order = input.order;
    if (input.isActive !== undefined) data.isActive = input.isActive;
    const reason = await tx.exclusionReason.update({ where: { id: before.id }, data });
    await audit.record(tx, {
      projectId,
      userId: ctx.userId,
      entityType: "ExclusionReason",
      entityId: reason.id,
      action: AuditActions.EXCLUSION_REASON_UPDATED,
      previousValue: exclusionReasonFields(before),
      newValue: exclusionReasonFields(reason),
    });
    return reason;
  });
}

// Hard-deletes when unreferenced; deactivates (isActive=false) when any ScreeningDecision or
// ScreeningAdjudication cites it — decisions must keep their reason for the record.
export async function deleteExclusionReason(ctx: Ctx, projectId: string, reasonId: string) {
  await requirePermission(ctx, projectId, "protocol.edit");
  return prisma.$transaction(async (tx) => {
    const before = await tx.exclusionReason.findFirst({ where: { id: reasonId, projectId } });
    if (!before) throw notFound("Exclusion reason");
    const [decisionRefs, adjudicationRefs] = await Promise.all([
      tx.screeningDecision.count({ where: { exclusionReasonId: before.id } }),
      tx.screeningAdjudication.count({ where: { exclusionReasonId: before.id } }),
    ]);
    const referenced = decisionRefs + adjudicationRefs > 0;
    if (referenced) {
      const reason = await tx.exclusionReason.update({
        where: { id: before.id },
        data: { isActive: false },
      });
      await audit.record(tx, {
        projectId,
        userId: ctx.userId,
        entityType: "ExclusionReason",
        entityId: before.id,
        action: AuditActions.EXCLUSION_REASON_DELETED,
        previousValue: exclusionReasonFields(before),
        newValue: exclusionReasonFields(reason),
        metadata: { softDeleted: true, decisionRefs, adjudicationRefs },
      });
      return { id: before.id, deleted: false, deactivated: true };
    }
    await tx.exclusionReason.delete({ where: { id: before.id } });
    await audit.record(tx, {
      projectId,
      userId: ctx.userId,
      entityType: "ExclusionReason",
      entityId: before.id,
      action: AuditActions.EXCLUSION_REASON_DELETED,
      previousValue: exclusionReasonFields(before),
      metadata: { softDeleted: false },
    });
    return { id: before.id, deleted: true, deactivated: false };
  });
}
