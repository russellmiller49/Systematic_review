// Outcome-field scaffolding: one call creates the NUMBER fields a measure needs on a
// DRAFT extraction template, the AnalysisOutcome, and the role mappings — atomically.
//
// Requires BOTH analysis.manage (it creates an analysis outcome) and
// extraction.templates (it adds template fields). The template must be a DRAFT
// (fields are addable only on drafts) and belong to the project (R9).
//
// Mapping note: replaceMappings deliberately rejects DRAFT templates because their
// fields are deletable/renamable, which would orphan a mapping. This atomic path is
// the sanctioned exception: it writes AnalysisFieldMap rows directly in the same
// transaction that creates the fields, and the extraction service refuses to delete
// or rename a mapped draft field — so the mappings cannot be orphaned.

import { z } from "zod";
import type { AnalysisRole, EffectMeasure } from "@prisma/client";
import { prisma } from "@/server/db";
import { notFound, validationError } from "@/server/errors";
import type { Ctx } from "@/server/auth/session";
import { requirePermission } from "@/server/permissions";
import * as audit from "@/server/services/audit";
import { AuditActions } from "@/server/services/audit";
import { ALL_MEASURES, toRow, type AnalysisOutcomeRow } from "./index";

const FIELD_KEY_RE = /^[a-z][a-z0-9_]*$/;

export const scaffoldOutcomeSchema = z.object({
  templateId: z.string().min(1),
  measure: z.enum(ALL_MEASURES),
  name: z.string().trim().min(1).max(300),
  keyPrefix: z
    .string()
    .max(60)
    .regex(FIELD_KEY_RE, "key prefix must start with a lowercase letter and use only a-z, 0-9, _"),
  timepoint: z.string().trim().max(200).optional(),
  direction: z.enum(["HIGHER_IS_BETTER", "LOWER_IS_BETTER"]).optional(),
  proportionTransform: z.enum(["LOGIT", "FREEMAN_TUKEY"]).optional(),
});

export type ScaffoldOutcomeInput = z.infer<typeof scaffoldOutcomeSchema>;

interface ScaffoldFieldSpec {
  role: AnalysisRole;
  suffix: string; // field key = `${keyPrefix}_${suffix}`
  label: string;
}

// One NUMBER field per statistical role the measure needs (GENERIC_IV scaffolds all
// four EFFECT_* fields so extractors can record whichever se-source the paper reports).
export function scaffoldFieldSpecs(measure: EffectMeasure): ScaffoldFieldSpec[] {
  switch (measure) {
    case "RR":
    case "OR":
    case "RD":
      return [
        { role: "G1_EVENTS", suffix: "g1_events", label: "Events — group 1" },
        { role: "G1_TOTAL", suffix: "g1_total", label: "Total — group 1" },
        { role: "G2_EVENTS", suffix: "g2_events", label: "Events — group 2" },
        { role: "G2_TOTAL", suffix: "g2_total", label: "Total — group 2" },
      ];
    case "MD":
    case "SMD":
      return [
        { role: "G1_MEAN", suffix: "g1_mean", label: "Mean — group 1" },
        { role: "G1_SD", suffix: "g1_sd", label: "SD — group 1" },
        { role: "G1_N", suffix: "g1_n", label: "N — group 1" },
        { role: "G2_MEAN", suffix: "g2_mean", label: "Mean — group 2" },
        { role: "G2_SD", suffix: "g2_sd", label: "SD — group 2" },
        { role: "G2_N", suffix: "g2_n", label: "N — group 2" },
      ];
    case "PROPORTION":
      return [
        { role: "G1_EVENTS", suffix: "g1_events", label: "Events" },
        { role: "G1_TOTAL", suffix: "g1_total", label: "Sample size" },
      ];
    case "GENERIC_IV":
      return [
        { role: "EFFECT_ESTIMATE", suffix: "effect_estimate", label: "Effect estimate" },
        { role: "EFFECT_SE", suffix: "effect_se", label: "Standard error" },
        { role: "EFFECT_CI_LOW", suffix: "effect_ci_low", label: "95% CI lower" },
        { role: "EFFECT_CI_UP", suffix: "effect_ci_up", label: "95% CI upper" },
      ];
    default:
      return [];
  }
}

export async function scaffoldOutcomeFields(
  ctx: Ctx,
  projectId: string,
  input: ScaffoldOutcomeInput,
): Promise<AnalysisOutcomeRow> {
  await requirePermission(ctx, projectId, "analysis.manage");
  await requirePermission(ctx, projectId, "extraction.templates");

  return prisma.$transaction(async (tx) => {
    // R9: the template must belong to this project.
    const template = await tx.extractionTemplate.findFirst({
      where: { id: input.templateId, projectId },
      include: { fields: { select: { key: true, order: true } } },
    });
    if (!template) throw notFound("Extraction template");
    if (template.status !== "DRAFT") {
      throw validationError(
        `Template "${template.name}" is ${template.status.toLowerCase()} — outcome fields can only be added to a draft`,
        { templateId: template.id, status: template.status },
      );
    }

    const specs = scaffoldFieldSpecs(input.measure);
    const keys = specs.map((spec) => `${input.keyPrefix}_${spec.suffix}`);
    const existingKeys = new Set(template.fields.map((f) => f.key));
    const collisions = keys.filter((key) => existingKeys.has(key));
    if (collisions.length > 0) {
      throw validationError(
        `Field key(s) already exist on this template: ${collisions.join(", ")} — pick a different key prefix`,
        { keys: collisions },
      );
    }

    // Fields append after the template's current field list, in a section named after
    // the outcome. Audit payloads match extraction.createField exactly.
    let order = template.fields.reduce((max, f) => Math.max(max, f.order + 1), 0);
    const fieldIdByRole = new Map<AnalysisRole, string>();
    for (let i = 0; i < specs.length; i++) {
      const spec = specs[i]!;
      const field = await tx.extractionField.create({
        data: {
          templateId: template.id,
          key: keys[i]!,
          label: spec.label,
          type: "NUMBER",
          section: input.name,
          required: false,
          order: order++,
        },
      });
      fieldIdByRole.set(spec.role, field.id);
      await audit.record(tx, {
        projectId,
        userId: ctx.userId,
        entityType: "ExtractionField",
        entityId: field.id,
        action: AuditActions.EXTRACTION_FIELD_CREATED,
        newValue: {
          templateId: template.id,
          key: field.key,
          label: field.label,
          type: field.type,
          required: field.required,
          options: field.options,
          order: field.order,
        },
      });
    }

    const outcomeOrder = await tx.analysisOutcome.count({ where: { projectId } });
    const outcome = await tx.analysisOutcome.create({
      data: {
        projectId,
        name: input.name,
        measure: input.measure,
        timepoint: input.timepoint ?? null,
        ...(input.direction !== undefined ? { direction: input.direction } : {}),
        ...(input.proportionTransform !== undefined
          ? { proportionTransform: input.proportionTransform }
          : {}),
        order: outcomeOrder,
        createdById: ctx.userId,
      },
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

    // Direct mapping writes — see the module comment for why replaceMappings is
    // (correctly) not used here.
    await tx.analysisFieldMap.createMany({
      data: specs.map((spec, i) => ({
        analysisOutcomeId: outcome.id,
        role: spec.role,
        templateId: template.id,
        fieldKey: keys[i]!,
      })),
    });
    const mappingsByRole = Object.fromEntries(
      specs.map((spec, i) => [spec.role, { templateId: template.id, fieldKey: keys[i]! }]),
    );
    await audit.record(tx, {
      projectId,
      userId: ctx.userId,
      entityType: "AnalysisOutcome",
      entityId: outcome.id,
      action: AuditActions.ANALYSIS_MAPPINGS_REPLACED,
      previousValue: { mappings: {} },
      newValue: { mappings: mappingsByRole },
    });

    const fresh = await tx.analysisOutcome.findFirstOrThrow({
      where: { id: outcome.id },
      include: { mappings: true },
    });
    return toRow(fresh);
  });
}
