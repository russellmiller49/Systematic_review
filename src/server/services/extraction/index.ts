// Extraction domain service: templates, fields, assignments, forms, values, conflicts,
// adjudication. Follows the exemplar shape (src/server/services/orgs):
//   - zod input schemas exported for route handlers
//   - ctx first arg; actor identity ONLY from ctx
//   - requirePermission first, invariants next, mutations inside prisma.$transaction
//   - audit.record(tx, ...) in the SAME transaction as every mutation
//   - by-id loads tenant-scoped (R9) → notFound on miss; body FK ids validated to the project
//
// Lifecycle rules implemented here (docs/09):
//   R15 — assignments gate form starts (project.edit holders may implicitly self-assign);
//         conflict detection runs when ≥2 COMPLETED forms exist for (template, study).
//   R16 — PUBLISHED templates are structurally immutable; new-version clones; publishing the
//         clone archives the source.
//   R5 mirror — a field is permanently locked once its conflict is RESOLVED (adjudicated).
//         While a conflict is OPEN, the disputed field stays editable on COMPLETED forms so
//         extractors can converge pre-adjudication (agreement auto-voids the conflict, the
//         extraction mirror of R6's "agreement after an edit → auto-resolve").

import { z } from "zod";
import {
  Prisma,
  type ConflictStatus,
  type ExtractionSuggestion,
  type ExtractionValue,
  type FieldType,
} from "@prisma/client";
import { prisma, type Tx } from "@/server/db";
import { conflict, forbidden, invalidState, notFound, validationError } from "@/server/errors";
import type { Ctx } from "@/server/auth/session";
import { can, requirePermission } from "@/server/permissions";
import * as audit from "@/server/services/audit";
import { AuditActions } from "@/server/services/audit";
import { matchQuote, normalizeForMatch } from "@/lib/quote-match";
import { sourceAnchorV2Schema, type SourceAnchorV2 } from "@/types/source-anchor";
import { validateFieldValue, valuesEqual, type FieldOption } from "./validation";

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

export const createTemplateSchema = z.object({
  name: z.string().trim().min(1).max(200),
  description: z.string().trim().max(2000).optional(),
});

export const updateTemplateSchema = z.object({
  name: z.string().trim().min(1).max(200).optional(),
  description: z.string().trim().max(2000).nullable().optional(),
});

const FIELD_TYPES = [
  "TEXT",
  "TEXTAREA",
  "NUMBER",
  "DATE",
  "SINGLE_SELECT",
  "MULTI_SELECT",
  "BOOLEAN",
] as const;

const FIELD_KEY_RE = /^[a-z][a-z0-9_]*$/;

const fieldOptionSchema = z.object({
  value: z.string().trim().min(1).max(200),
  label: z.string().trim().min(1).max(200),
});

export const createFieldSchema = z.object({
  key: z
    .string()
    .max(100)
    .regex(FIELD_KEY_RE, "key must start with a lowercase letter and use only a-z, 0-9, _"),
  label: z.string().trim().min(1).max(200),
  type: z.enum(FIELD_TYPES),
  section: z.string().trim().min(1).max(200).optional(),
  helpText: z.string().trim().max(2000).optional(),
  required: z.boolean().optional(),
  options: z.array(fieldOptionSchema).optional(),
  order: z.number().int().min(0).optional(),
});

export const updateFieldSchema = z.object({
  key: z
    .string()
    .max(100)
    .regex(FIELD_KEY_RE, "key must start with a lowercase letter and use only a-z, 0-9, _")
    .optional(),
  label: z.string().trim().min(1).max(200).optional(),
  type: z.enum(FIELD_TYPES).optional(),
  section: z.string().trim().min(1).max(200).nullable().optional(),
  helpText: z.string().trim().max(2000).nullable().optional(),
  required: z.boolean().optional(),
  options: z.array(fieldOptionSchema).nullable().optional(),
  order: z.number().int().min(0).optional(),
});

export const createAssignmentsSchema = z.object({
  templateId: z.string().min(1),
  studyIds: z.array(z.string().min(1)).min(1).max(500),
  extractorIds: z.array(z.string().min(1)).min(1).max(100),
});

export const startFormSchema = z.object({
  templateId: z.string().min(1),
  citationId: z.string().min(1).optional(),
});

export const upsertValueSchema = z.object({
  value: z.unknown(), // typed against the field in the service; null (or omitted) clears
  sourceQuote: z.string().trim().min(1).max(8000).nullable().optional(),
  pageNumber: z.number().int().min(1).nullable().optional(),
  // Anchor v2 (src/types/source-anchor): where the quote lives in the study's PDF.
  // fileId is R9-checked against the project in the service; null clears the anchor.
  sourceAnchor: sourceAnchorV2Schema.nullable().optional(),
  notes: z.string().trim().max(8000).nullable().optional(),
  // Apply an AI suggestion (server-authoritative): when present, value/sourceQuote/
  // pageNumber/sourceAnchor are copied from the ExtractionSuggestion row — the client
  // body's value is ignored. The human extractor remains the author of the write.
  appliedSuggestionId: z.string().min(1).optional(),
});

export const listConflictsQuerySchema = z.object({
  status: z.enum(["OPEN", "RESOLVED", "VOIDED"]).optional(),
});

export const adjudicateConflictSchema = z.object({
  finalValue: z.unknown(), // typed against the conflict's field in the service
  reason: z.string().trim().min(3).max(4000),
});

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

const TEMPLATE_IMMUTABLE_MSG = "Published templates are immutable — create a new version";

const SELECT_TYPES: ReadonlySet<FieldType> = new Set(["SINGLE_SELECT", "MULTI_SELECT"]);

async function getTemplateOr404(tx: Tx, projectId: string, templateId: string) {
  const template = await tx.extractionTemplate.findFirst({
    where: { id: templateId, projectId },
  });
  if (!template) throw notFound("Extraction template");
  return template;
}

async function getDraftTemplateOr404(tx: Tx, projectId: string, templateId: string) {
  const template = await getTemplateOr404(tx, projectId, templateId);
  if (template.status !== "DRAFT") throw invalidState(TEMPLATE_IMMUTABLE_MSG);
  return template;
}

async function getStudyOr404(tx: Tx, projectId: string, studyId: string) {
  const study = await tx.study.findFirst({ where: { id: studyId, projectId } });
  if (!study) throw notFound("Study");
  return study;
}

// options are stored ONLY for select types (non-empty, unique values); null otherwise.
function normalizeOptions(type: FieldType, options: FieldOption[] | null | undefined) {
  if (!SELECT_TYPES.has(type)) return null;
  if (!options || options.length === 0) {
    throw validationError("Select fields require a non-empty options list");
  }
  const values = options.map((o) => o.value);
  if (new Set(values).size !== values.length) {
    throw validationError("Option values must be unique");
  }
  return options;
}

const fieldsOrdered = {
  orderBy: [{ order: "asc" }, { createdAt: "asc" }],
} satisfies Prisma.ExtractionTemplate$fieldsArgs;

const formInclude = {
  template: { select: { id: true, name: true, version: true, status: true } },
  study: { select: { id: true, label: true } },
  extractor: { select: { id: true, name: true } },
  values: true,
} satisfies Prisma.ExtractionFormInclude;

// ---------------------------------------------------------------------------
// Templates
// ---------------------------------------------------------------------------

export async function listTemplates(ctx: Ctx, projectId: string) {
  await requirePermission(ctx, projectId, "project.view");
  return prisma.extractionTemplate.findMany({
    where: { projectId },
    include: { fields: fieldsOrdered },
    orderBy: { createdAt: "asc" },
  });
}

export async function createTemplate(
  ctx: Ctx,
  projectId: string,
  input: z.infer<typeof createTemplateSchema>,
) {
  await requirePermission(ctx, projectId, "extraction.templates");
  return prisma.$transaction(async (tx) => {
    const template = await tx.extractionTemplate.create({
      data: {
        projectId,
        name: input.name,
        description: input.description ?? null,
        createdById: ctx.userId,
      },
    });
    await audit.record(tx, {
      projectId,
      userId: ctx.userId,
      entityType: "ExtractionTemplate",
      entityId: template.id,
      action: AuditActions.EXTRACTION_TEMPLATE_CREATED,
      newValue: { name: template.name, version: template.version, status: template.status },
    });
    return template;
  });
}

export async function getTemplate(ctx: Ctx, projectId: string, templateId: string) {
  await requirePermission(ctx, projectId, "project.view");
  const template = await prisma.extractionTemplate.findFirst({
    where: { id: templateId, projectId },
    include: { fields: fieldsOrdered },
  });
  if (!template) throw notFound("Extraction template");
  return template;
}

// R16: PUBLISHED templates stay editable for name/description only (structure is frozen).
export async function updateTemplate(
  ctx: Ctx,
  projectId: string,
  templateId: string,
  input: z.infer<typeof updateTemplateSchema>,
) {
  await requirePermission(ctx, projectId, "extraction.templates");
  return prisma.$transaction(async (tx) => {
    const before = await getTemplateOr404(tx, projectId, templateId);
    const template = await tx.extractionTemplate.update({
      where: { id: before.id },
      data: {
        ...(input.name !== undefined && { name: input.name }),
        ...(input.description !== undefined && { description: input.description }),
      },
    });
    await audit.record(tx, {
      projectId,
      userId: ctx.userId,
      entityType: "ExtractionTemplate",
      entityId: template.id,
      action: AuditActions.EXTRACTION_TEMPLATE_UPDATED,
      previousValue: { name: before.name, description: before.description },
      newValue: { name: template.name, description: template.description },
    });
    return template;
  });
}

export async function publishTemplate(ctx: Ctx, projectId: string, templateId: string) {
  await requirePermission(ctx, projectId, "extraction.templates");
  return prisma.$transaction(async (tx) => {
    const template = await getTemplateOr404(tx, projectId, templateId);
    if (template.status !== "DRAFT") {
      throw invalidState("Only draft templates can be published");
    }
    const fieldCount = await tx.extractionField.count({ where: { templateId: template.id } });
    if (fieldCount === 0) {
      throw invalidState("Cannot publish a template with no fields");
    }
    const published = await tx.extractionTemplate.update({
      where: { id: template.id },
      data: { status: "PUBLISHED" },
    });
    await audit.record(tx, {
      projectId,
      userId: ctx.userId,
      entityType: "ExtractionTemplate",
      entityId: template.id,
      action: AuditActions.EXTRACTION_TEMPLATE_PUBLISHED,
      previousValue: { status: "DRAFT" },
      newValue: { status: "PUBLISHED", version: template.version },
    });
    // R16: publishing a clone archives its source version.
    if (template.sourceTemplateId) {
      const source = await tx.extractionTemplate.findFirst({
        where: { id: template.sourceTemplateId, projectId, status: "PUBLISHED" },
      });
      if (source) {
        await tx.extractionTemplate.update({
          where: { id: source.id },
          data: { status: "ARCHIVED" },
        });
        // Closest catalog fit — there is no EXTRACTION_TEMPLATE_ARCHIVED action.
        await audit.record(tx, {
          projectId,
          userId: ctx.userId,
          entityType: "ExtractionTemplate",
          entityId: source.id,
          action: AuditActions.EXTRACTION_TEMPLATE_UPDATED,
          previousValue: { status: "PUBLISHED" },
          newValue: { status: "ARCHIVED" },
          metadata: { archivedByTemplateId: template.id, archivedByVersion: template.version },
        });
      }
    }
    return published;
  });
}

// R16: "edit a published template" = clone template + fields into a new DRAFT (version+1).
export async function createNewVersion(ctx: Ctx, projectId: string, templateId: string) {
  await requirePermission(ctx, projectId, "extraction.templates");
  return prisma.$transaction(async (tx) => {
    const source = await getTemplateOr404(tx, projectId, templateId);
    if (source.status !== "PUBLISHED") {
      throw invalidState("Only published templates can be versioned");
    }
    const fields = await tx.extractionField.findMany({
      where: { templateId: source.id },
      orderBy: [{ order: "asc" }, { createdAt: "asc" }],
    });
    const clone = await tx.extractionTemplate.create({
      data: {
        projectId,
        name: source.name,
        description: source.description,
        status: "DRAFT",
        version: source.version + 1,
        sourceTemplateId: source.id,
        createdById: ctx.userId,
      },
    });
    for (const f of fields) {
      await tx.extractionField.create({
        data: {
          templateId: clone.id,
          key: f.key,
          label: f.label,
          type: f.type,
          section: f.section,
          helpText: f.helpText,
          required: f.required,
          options: f.options === null ? undefined : (f.options as Prisma.InputJsonValue),
          order: f.order,
        },
      });
    }
    await audit.record(tx, {
      projectId,
      userId: ctx.userId,
      entityType: "ExtractionTemplate",
      entityId: clone.id,
      action: AuditActions.EXTRACTION_TEMPLATE_CREATED,
      newValue: { name: clone.name, version: clone.version, status: clone.status },
      metadata: { sourceTemplateId: source.id, clonedFields: fields.length },
    });
    return tx.extractionTemplate.findUniqueOrThrow({
      where: { id: clone.id },
      include: { fields: fieldsOrdered },
    });
  });
}

// ---------------------------------------------------------------------------
// Fields (DRAFT templates only)
// ---------------------------------------------------------------------------

export async function createField(
  ctx: Ctx,
  projectId: string,
  templateId: string,
  input: z.infer<typeof createFieldSchema>,
) {
  await requirePermission(ctx, projectId, "extraction.templates");
  return prisma.$transaction(async (tx) => {
    const template = await getDraftTemplateOr404(tx, projectId, templateId);
    const options = normalizeOptions(input.type, input.options ?? null);
    const existing = await tx.extractionField.findUnique({
      where: { templateId_key: { templateId: template.id, key: input.key } },
    });
    if (existing) {
      throw conflict(`A field with key "${input.key}" already exists in this template`);
    }
    const field = await tx.extractionField.create({
      data: {
        templateId: template.id,
        key: input.key,
        label: input.label,
        type: input.type,
        section: input.section ?? null,
        helpText: input.helpText ?? null,
        required: input.required ?? false,
        options: options === null ? undefined : (options as Prisma.InputJsonValue),
        order: input.order ?? 0,
      },
    });
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
    return field;
  });
}

export async function updateField(
  ctx: Ctx,
  projectId: string,
  templateId: string,
  fieldId: string,
  input: z.infer<typeof updateFieldSchema>,
) {
  await requirePermission(ctx, projectId, "extraction.templates");
  return prisma.$transaction(async (tx) => {
    const template = await getDraftTemplateOr404(tx, projectId, templateId);
    const field = await tx.extractionField.findFirst({
      where: { id: fieldId, templateId: template.id },
    });
    if (!field) throw notFound("Extraction field");

    const nextType = input.type ?? field.type;
    // Analysis mappings require NUMBER fields; retyping a mapped draft field would
    // silently starve its roles (same guard family as the rename/delete checks below).
    if (nextType !== field.type) {
      const mapped = await tx.analysisFieldMap.count({
        where: { templateId: template.id, fieldKey: field.key },
      });
      if (mapped > 0) {
        throw invalidState(
          `Field "${field.key}" is mapped to ${mapped} analysis role(s) — remove the mappings before changing its type`,
        );
      }
    }
    const nextOptions =
      input.options !== undefined ? input.options : (field.options as FieldOption[] | null);
    const options = normalizeOptions(nextType, nextOptions);

    if (input.key !== undefined && input.key !== field.key) {
      const dupe = await tx.extractionField.findUnique({
        where: { templateId_key: { templateId: template.id, key: input.key } },
      });
      if (dupe) throw conflict(`A field with key "${input.key}" already exists in this template`);
      // Analysis mappings reference (templateId, fieldKey) with no FK (lineage survival);
      // renaming a mapped key would orphan them (scaffolded outcomes map draft fields).
      const mapped = await tx.analysisFieldMap.count({
        where: { templateId: template.id, fieldKey: field.key },
      });
      if (mapped > 0) {
        throw invalidState(
          `Field "${field.key}" is mapped to ${mapped} analysis role(s) — remove the mappings before renaming its key`,
        );
      }
    }

    const updated = await tx.extractionField.update({
      where: { id: field.id },
      data: {
        ...(input.key !== undefined && { key: input.key }),
        ...(input.label !== undefined && { label: input.label }),
        ...(input.type !== undefined && { type: input.type }),
        ...(input.section !== undefined && { section: input.section }),
        ...(input.helpText !== undefined && { helpText: input.helpText }),
        ...(input.required !== undefined && { required: input.required }),
        ...(input.order !== undefined && { order: input.order }),
        options: options === null ? Prisma.JsonNull : (options as Prisma.InputJsonValue),
      },
    });
    await audit.record(tx, {
      projectId,
      userId: ctx.userId,
      entityType: "ExtractionField",
      entityId: field.id,
      action: AuditActions.EXTRACTION_FIELD_UPDATED,
      previousValue: {
        key: field.key,
        label: field.label,
        type: field.type,
        required: field.required,
        options: field.options,
        order: field.order,
        section: field.section,
        helpText: field.helpText,
      },
      newValue: {
        key: updated.key,
        label: updated.label,
        type: updated.type,
        required: updated.required,
        options: updated.options,
        order: updated.order,
        section: updated.section,
        helpText: updated.helpText,
      },
    });
    return updated;
  });
}

export async function deleteField(
  ctx: Ctx,
  projectId: string,
  templateId: string,
  fieldId: string,
) {
  await requirePermission(ctx, projectId, "extraction.templates");
  return prisma.$transaction(async (tx) => {
    const template = await getDraftTemplateOr404(tx, projectId, templateId);
    const field = await tx.extractionField.findFirst({
      where: { id: fieldId, templateId: template.id },
    });
    if (!field) throw notFound("Extraction field");
    // Analysis mappings reference (templateId, fieldKey) without an FK — refuse to
    // delete a mapped field (would leave a mapping that resolves to nothing).
    const mapped = await tx.analysisFieldMap.count({
      where: { templateId: template.id, fieldKey: field.key },
    });
    if (mapped > 0) {
      throw invalidState(
        `Field "${field.key}" is mapped to ${mapped} analysis role(s) — remove the mappings before deleting it`,
      );
    }
    // Forms only ever attach to PUBLISHED templates, so a DRAFT field has no values.
    await tx.extractionField.delete({ where: { id: field.id } });
    await audit.record(tx, {
      projectId,
      userId: ctx.userId,
      entityType: "ExtractionField",
      entityId: field.id,
      action: AuditActions.EXTRACTION_FIELD_DELETED,
      previousValue: {
        templateId: template.id,
        key: field.key,
        label: field.label,
        type: field.type,
        required: field.required,
      },
    });
    return { deleted: true };
  });
}

// ---------------------------------------------------------------------------
// Assignments (R15)
// ---------------------------------------------------------------------------

export async function createAssignments(
  ctx: Ctx,
  projectId: string,
  input: z.infer<typeof createAssignmentsSchema>,
) {
  await requirePermission(ctx, projectId, "project.edit");
  return prisma.$transaction(async (tx) => {
    const template = await getTemplateOr404(tx, projectId, input.templateId);
    if (template.status !== "PUBLISHED") {
      throw invalidState("Assignments require a published template");
    }
    const studyIds = [...new Set(input.studyIds)];
    const extractorIds = [...new Set(input.extractorIds)];

    const studies = await tx.study.findMany({ where: { id: { in: studyIds }, projectId } });
    if (studies.length !== studyIds.length) throw notFound("Study");

    const members = await tx.projectMember.findMany({
      where: { projectId, userId: { in: extractorIds }, status: "ACTIVE" },
    });
    const memberByUser = new Map(members.map((m) => [m.userId, m]));
    for (const extractorId of extractorIds) {
      const member = memberByUser.get(extractorId);
      if (!member) throw notFound("Extractor");
      if (!can(member.roles, "extraction.perform")) {
        throw validationError("Extractors must be active project members who can perform extraction", {
          userId: extractorId,
        });
      }
    }

    const existing = await tx.extractionAssignment.findMany({
      where: {
        templateId: template.id,
        studyId: { in: studyIds },
        extractorId: { in: extractorIds },
      },
    });
    const existingKeys = new Set(existing.map((a) => `${a.studyId}:${a.extractorId}`));

    const created = [];
    for (const studyId of studyIds) {
      for (const extractorId of extractorIds) {
        if (existingKeys.has(`${studyId}:${extractorId}`)) continue; // skip-existing
        const assignment = await tx.extractionAssignment.create({
          data: { templateId: template.id, studyId, extractorId },
        });
        await audit.record(tx, {
          projectId,
          userId: ctx.userId,
          entityType: "ExtractionAssignment",
          entityId: assignment.id,
          action: AuditActions.EXTRACTION_ASSIGNED,
          newValue: { templateId: template.id, studyId, extractorId },
        });
        created.push(assignment);
      }
    }
    return { created, skipped: existing.length };
  });
}

export async function listAssignments(ctx: Ctx, projectId: string, opts: { mine: boolean }) {
  const member = await requirePermission(ctx, projectId, "project.view");
  if (opts.mine) {
    return prisma.extractionAssignment.findMany({
      where: { extractorId: ctx.userId, status: "PENDING", template: { projectId } },
      include: {
        study: { select: { id: true, label: true } },
        template: { select: { id: true, name: true, version: true, status: true } },
      },
      orderBy: { createdAt: "asc" },
    });
  }
  if (!can(member.roles, "project.edit")) {
    throw forbidden("Listing all assignments requires project management access");
  }
  return prisma.extractionAssignment.findMany({
    where: { template: { projectId } },
    include: {
      study: { select: { id: true, label: true } },
      template: { select: { id: true, name: true, version: true, status: true } },
      extractor: { select: { id: true, name: true } },
    },
    orderBy: { createdAt: "asc" },
  });
}

// ---------------------------------------------------------------------------
// Forms
// ---------------------------------------------------------------------------

export async function startForm(
  ctx: Ctx,
  projectId: string,
  studyId: string,
  input: z.infer<typeof startFormSchema>,
) {
  const member = await requirePermission(ctx, projectId, "extraction.perform");
  return prisma.$transaction(async (tx) => {
    const template = await getTemplateOr404(tx, projectId, input.templateId);
    if (template.status !== "PUBLISHED") {
      throw invalidState("Extraction requires a published template");
    }
    const study = await getStudyOr404(tx, projectId, studyId);
    if (input.citationId) {
      const citation = await tx.citation.findFirst({
        where: { id: input.citationId, projectId },
      });
      if (!citation) throw notFound("Citation");
    }

    const key = {
      templateId_studyId_extractorId: {
        templateId: template.id,
        studyId: study.id,
        extractorId: ctx.userId,
      },
    };
    const existingForm = await tx.extractionForm.findUnique({
      where: key,
      include: formInclude,
    });
    if (existingForm) return { form: existingForm, created: false };

    // R15: starting a form requires an assignment; project.edit holders self-assign implicitly.
    const assignment = await tx.extractionAssignment.findUnique({ where: key });
    const activeAssignment = assignment && assignment.status !== "VOIDED" ? assignment : null;
    if (!activeAssignment) {
      if (!can(member.roles, "project.edit")) {
        throw forbidden("You are not assigned to extract this study");
      }
      const selfAssigned = assignment
        ? await tx.extractionAssignment.update({
            where: { id: assignment.id },
            data: { status: "PENDING" },
          })
        : await tx.extractionAssignment.create({
            data: { templateId: template.id, studyId: study.id, extractorId: ctx.userId },
          });
      await audit.record(tx, {
        projectId,
        userId: ctx.userId,
        entityType: "ExtractionAssignment",
        entityId: selfAssigned.id,
        action: AuditActions.EXTRACTION_ASSIGNED,
        newValue: { templateId: template.id, studyId: study.id, extractorId: ctx.userId },
        metadata: { implicitSelfAssign: true },
      });
    }

    const form = await tx.extractionForm.create({
      data: {
        templateId: template.id,
        studyId: study.id,
        citationId: input.citationId ?? null,
        extractorId: ctx.userId,
      },
      include: formInclude,
    });
    await audit.record(tx, {
      projectId,
      userId: ctx.userId,
      entityType: "ExtractionForm",
      entityId: form.id,
      action: AuditActions.EXTRACTION_FORM_STARTED,
      newValue: { templateId: template.id, studyId: study.id, citationId: input.citationId ?? null },
    });
    return { form, created: true };
  });
}

// Blind mirror: extractors see only their own forms; extraction.adjudicate or project.edit
// holders see every form for the project.
export async function listForms(
  ctx: Ctx,
  projectId: string,
  filters: { studyId?: string; templateId?: string },
) {
  const member = await requirePermission(ctx, projectId, "project.view");
  const seeAll = can(member.roles, "extraction.adjudicate") || can(member.roles, "project.edit");
  return prisma.extractionForm.findMany({
    where: {
      template: { projectId },
      ...(filters.studyId ? { studyId: filters.studyId } : {}),
      ...(filters.templateId ? { templateId: filters.templateId } : {}),
      ...(seeAll ? {} : { extractorId: ctx.userId }),
    },
    include: formInclude,
    orderBy: { createdAt: "asc" },
  });
}

// ---------------------------------------------------------------------------
// Values
// ---------------------------------------------------------------------------

// Manual-save anchor resolution (the appliedSuggestionId path copies the suggestion's
// anchor verbatim instead). R9: the body-supplied fileId must belong to this project.
// When the file has an EXTRACTED server text layer and a quote accompanies the anchor,
// the SERVER's match result is authoritative — stored offsets must index OUR stored
// page text, never the client's pdf.js output. A client "selection" keeps its
// provenance label but takes the server's offsets/score.
async function resolveManualAnchor(
  tx: Tx,
  projectId: string,
  anchor: SourceAnchorV2,
  quote: string | null | undefined,
): Promise<SourceAnchorV2> {
  const file = await tx.fullTextFile.findFirst({
    where: { id: anchor.fileId, projectId },
    select: { id: true, pageCount: true, textStatus: true, textVersion: true },
  });
  if (!file) throw notFound("File");
  if (file.pageCount !== null && anchor.page > file.pageCount) {
    throw validationError(
      `Anchor page ${anchor.page} is beyond the document (${file.pageCount} pages)`,
    );
  }
  const keepSelectionLabel = anchor.matchQuality === "selection";
  if (file.textStatus !== "EXTRACTED") {
    // No server text layer: client offsets index nothing we store — keep the page and
    // the provenance label, drop the offsets (the viewer re-locates by quote anyway).
    if (anchor.charStart === undefined) return anchor;
    const { charStart: _cs, charEnd: _ce, ...pageLevel } = anchor;
    return pageLevel;
  }
  const rows = await tx.fullTextPage.findMany({
    where: { fileId: file.id },
    orderBy: { page: "asc" },
    select: { page: true, text: true },
  });
  const pages = rows.map((r) => ({ page: r.page, text: normalizeForMatch(r.text) }));
  const anchorPageText = pages.find((p) => p.page === anchor.page)?.text;
  const offsetsInBounds =
    anchor.charStart !== undefined &&
    anchor.charEnd !== undefined &&
    anchorPageText !== undefined &&
    anchor.charEnd <= anchorPageText.length;

  if (!quote) {
    // No quote to verify content against — keep offsets only when they are at least
    // bounds-sane for our stored text, and stamp the version they were checked against.
    if (!offsetsInBounds) {
      const { charStart: _cs, charEnd: _ce, ...pageLevel } = anchor;
      return { ...pageLevel, textVersion: file.textVersion };
    }
    return { ...anchor, textVersion: file.textVersion };
  }

  // A user selection that verifies against OUR text keeps its exact offsets — the
  // quote may occur several times on the page ("12 months", "45%") and matchQuote
  // would snap every occurrence to the first one, erasing the user's disambiguation.
  if (keepSelectionLabel && offsetsInBounds) {
    const selected = anchorPageText!.slice(anchor.charStart, anchor.charEnd);
    if (selected.toLowerCase() === normalizeForMatch(quote).toLowerCase()) {
      return {
        v: 2,
        fileId: file.id,
        page: anchor.page,
        charStart: anchor.charStart,
        charEnd: anchor.charEnd,
        matchQuality: "selection",
        matchScore: 1,
        textVersion: file.textVersion,
      };
    }
  }

  const m = matchQuote(pages, quote, anchor.page);
  if (m.quality === "exact" || m.quality === "fuzzy") {
    return {
      v: 2,
      fileId: file.id,
      page: m.page,
      charStart: m.charStart,
      charEnd: m.charEnd,
      matchQuality: keepSelectionLabel ? "selection" : m.quality,
      matchScore: m.score,
      textVersion: file.textVersion,
    };
  }
  // Verification failed: client offsets can't be trusted against our text — keep the
  // page (already bounds-checked) and the provenance label, drop the offsets.
  return {
    v: 2,
    fileId: file.id,
    page: anchor.page,
    matchQuality: keepSelectionLabel ? "selection" : "page-only",
    textVersion: file.textVersion,
  };
}

export async function upsertValue(
  ctx: Ctx,
  projectId: string,
  formId: string,
  fieldId: string,
  input: z.infer<typeof upsertValueSchema>,
): Promise<ExtractionValue | null> {
  await requirePermission(ctx, projectId, "extraction.perform");
  return prisma.$transaction(async (tx) => {
    const form = await tx.extractionForm.findFirst({
      where: { id: formId, template: { projectId } },
    });
    if (!form) throw notFound("Extraction form");
    if (form.extractorId !== ctx.userId) {
      // Admins included — only the extractor writes to their own blinded form.
      throw forbidden("Only the form's extractor can edit its values");
    }
    const field = await tx.extractionField.findFirst({
      where: { id: fieldId, templateId: form.templateId },
    });
    if (!field) throw notFound("Extraction field");

    const fieldConflict = await tx.extractionConflict.findUnique({
      where: { studyId_fieldId: { studyId: form.studyId, fieldId: field.id } },
    });
    // R5 mirror: adjudicated (RESOLVED) conflict permanently locks the field.
    if (fieldConflict?.status === "RESOLVED") {
      throw invalidState("This field's conflict has been adjudicated — the value is locked");
    }
    // Completed forms are read-only except for fields under an OPEN conflict (pre-adjudication
    // convergence path; agreement auto-voids the conflict below).
    if (form.status !== "IN_PROGRESS" && fieldConflict?.status !== "OPEN") {
      throw invalidState("Form is completed — only fields with an open conflict can be edited");
    }

    // AI-suggestion apply: the suggestion must belong to this exact (template, study, field)
    // and be applyable (not notFound, not invalid, non-null value). Its value still goes
    // through validateFieldValue and every guard above — the AI never bypasses the human
    // write path (docs/01 integrity rule 2).
    let appliedSuggestion: ExtractionSuggestion | null = null;
    if (input.appliedSuggestionId) {
      appliedSuggestion = await tx.extractionSuggestion.findFirst({
        where: {
          id: input.appliedSuggestionId,
          templateId: form.templateId,
          studyId: form.studyId,
          fieldId: field.id,
          notFound: false,
          invalidReason: null,
        },
      });
      if (!appliedSuggestion || appliedSuggestion.value === null) {
        throw notFound("Applyable AI suggestion");
      }
    }

    const existing = await tx.extractionValue.findUnique({
      where: { formId_fieldId: { formId: form.id, fieldId: field.id } },
    });
    const rawValue = appliedSuggestion
      ? appliedSuggestion.value
      : input.value === undefined
        ? null
        : input.value;

    // Anchor v2 on manual saves: validate/verify the body's anchor before it can be
    // stored (null clears it; the apply path below copies the suggestion's instead).
    // Resolved only for real writes — a clear discards provenance with the row.
    let manualAnchor: Prisma.InputJsonValue | typeof Prisma.JsonNull | undefined;
    if (!appliedSuggestion && input.sourceAnchor !== undefined && rawValue !== null) {
      manualAnchor =
        input.sourceAnchor === null
          ? Prisma.JsonNull
          : ((await resolveManualAnchor(
              tx,
              projectId,
              input.sourceAnchor,
              input.sourceQuote,
            )) as unknown as Prisma.InputJsonValue);
    }

    // Provenance written alongside the value: on apply it comes from the suggestion row
    // (including the sourceAnchor slot); on manual edits only explicitly provided fields
    // change, matching the existing behavior.
    const provenancePatch = appliedSuggestion
      ? {
          sourceQuote: appliedSuggestion.sourceQuote,
          pageNumber: appliedSuggestion.pageNumber,
          sourceAnchor:
            appliedSuggestion.sourceAnchor === null
              ? Prisma.JsonNull
              : (appliedSuggestion.sourceAnchor as Prisma.InputJsonValue),
          ...(input.notes !== undefined && { notes: input.notes }),
        }
      : {
          ...(input.sourceQuote !== undefined && { sourceQuote: input.sourceQuote }),
          ...(input.pageNumber !== undefined && { pageNumber: input.pageNumber }),
          ...(manualAnchor !== undefined && { sourceAnchor: manualAnchor }),
          ...(input.notes !== undefined && { notes: input.notes }),
        };
    const aiAuditMetadata = appliedSuggestion
      ? {
          appliedFromSuggestionId: appliedSuggestion.id,
          aiProvider: appliedSuggestion.provider,
          aiModel: appliedSuggestion.model,
        }
      : {};

    let result: ExtractionValue | null;
    if (rawValue === null) {
      // Clear: delete the row.
      if (existing) {
        await tx.extractionValue.delete({ where: { id: existing.id } });
        await audit.record(tx, {
          projectId,
          userId: ctx.userId,
          entityType: "ExtractionValue",
          entityId: existing.id,
          action: AuditActions.EXTRACTION_VALUE_UPDATED,
          previousValue: {
            value: existing.value,
            sourceQuote: existing.sourceQuote,
            pageNumber: existing.pageNumber,
            sourceAnchor: existing.sourceAnchor,
          },
          newValue: { value: null },
          metadata: { cleared: true, formId: form.id, fieldKey: field.key },
        });
      }
      result = null;
    } else {
      const value = validateFieldValue(field, rawValue) as Prisma.InputJsonValue;
      if (existing) {
        result = await tx.extractionValue.update({
          where: { id: existing.id },
          data: { value, ...provenancePatch },
        });
        await audit.record(tx, {
          projectId,
          userId: ctx.userId,
          entityType: "ExtractionValue",
          entityId: existing.id,
          action: AuditActions.EXTRACTION_VALUE_UPDATED,
          // Integrity rule 6: every change carries the previous value.
          previousValue: {
            value: existing.value,
            sourceQuote: existing.sourceQuote,
            pageNumber: existing.pageNumber,
            sourceAnchor: existing.sourceAnchor,
          },
          newValue: {
            value: result.value,
            sourceQuote: result.sourceQuote,
            pageNumber: result.pageNumber,
            sourceAnchor: result.sourceAnchor,
          },
          metadata: { formId: form.id, fieldKey: field.key, ...aiAuditMetadata },
        });
      } else {
        result = await tx.extractionValue.create({
          data: {
            formId: form.id,
            fieldId: field.id,
            value,
            sourceQuote: null,
            pageNumber: null,
            notes: null,
            ...provenancePatch,
          },
        });
        await audit.record(tx, {
          projectId,
          userId: ctx.userId,
          entityType: "ExtractionValue",
          entityId: result.id,
          action: AuditActions.EXTRACTION_VALUE_CREATED,
          newValue: {
            value: result.value,
            sourceQuote: result.sourceQuote,
            pageNumber: result.pageNumber,
            sourceAnchor: result.sourceAnchor,
          },
          metadata: { formId: form.id, fieldKey: field.key, ...aiAuditMetadata },
        });
      }
    }

    // An edit on a COMPLETED form can only be a disputed-field edit — re-evaluate agreement
    // so conflicts auto-void when extractors converge (R6 mirror).
    if (form.status === "COMPLETED") {
      await evaluateFieldConflicts(tx, ctx, projectId, form.templateId, form.studyId, [field.id]);
    }
    return result;
  });
}

// ---------------------------------------------------------------------------
// Completion + conflict detection (R15)
// ---------------------------------------------------------------------------

export async function completeForm(ctx: Ctx, projectId: string, formId: string) {
  await requirePermission(ctx, projectId, "extraction.perform");
  return prisma.$transaction(async (tx) => {
    const form = await tx.extractionForm.findFirst({
      where: { id: formId, template: { projectId } },
      include: { template: { include: { fields: true } }, values: true },
    });
    if (!form) throw notFound("Extraction form");
    if (form.extractorId !== ctx.userId) {
      throw forbidden("Only the form's extractor can complete it");
    }
    if (form.status !== "IN_PROGRESS") throw invalidState("Form is already completed");

    const filled = new Set(form.values.map((v) => v.fieldId));
    const missing = form.template.fields
      .filter((f) => f.required && !filled.has(f.id))
      .map((f) => f.key)
      .sort();
    if (missing.length > 0) {
      throw validationError("Required fields are missing values", { missing });
    }

    const completed = await tx.extractionForm.update({
      where: { id: form.id },
      data: { status: "COMPLETED", completedAt: new Date() },
    });

    // Assignment leaves the extractor's queue once the form is done.
    const assignment = await tx.extractionAssignment.findUnique({
      where: {
        templateId_studyId_extractorId: {
          templateId: form.templateId,
          studyId: form.studyId,
          extractorId: ctx.userId,
        },
      },
    });
    if (assignment?.status === "PENDING") {
      await tx.extractionAssignment.update({
        where: { id: assignment.id },
        data: { status: "COMPLETED" },
      });
    }

    await audit.record(tx, {
      projectId,
      userId: ctx.userId,
      entityType: "ExtractionForm",
      entityId: form.id,
      action: AuditActions.EXTRACTION_FORM_COMPLETED,
      previousValue: { status: "IN_PROGRESS" },
      newValue: { status: "COMPLETED" },
      metadata: { templateId: form.templateId, studyId: form.studyId },
    });

    // R15: same-transaction conflict detection across all COMPLETED forms.
    await evaluateFieldConflicts(tx, ctx, projectId, form.templateId, form.studyId);
    return completed;
  });
}

// Compares values across every COMPLETED form for (template, study), field by field.
// differ + no conflict row → open; differ + VOIDED row → reopen; agree + OPEN row → void.
// RESOLVED conflicts are never touched (post-adjudication lock).
async function evaluateFieldConflicts(
  tx: Tx,
  ctx: Ctx,
  projectId: string,
  templateId: string,
  studyId: string,
  onlyFieldIds?: string[],
) {
  const completedForms = await tx.extractionForm.findMany({
    where: { templateId, studyId, status: "COMPLETED" },
    include: { values: true },
  });
  if (completedForms.length < 2) return;

  const fields = await tx.extractionField.findMany({
    where: { templateId, ...(onlyFieldIds ? { id: { in: onlyFieldIds } } : {}) },
  });
  const conflicts = await tx.extractionConflict.findMany({
    where: { templateId, studyId, fieldId: { in: fields.map((f) => f.id) } },
  });
  const conflictByField = new Map(conflicts.map((c) => [c.fieldId, c]));

  for (const field of fields) {
    const values = completedForms.map(
      (f) => f.values.find((v) => v.fieldId === field.id)?.value ?? null,
    );
    const agree = values.every((v) => valuesEqual(field.type, values[0], v));
    const existing = conflictByField.get(field.id);

    if (!agree) {
      if (!existing) {
        const opened = await tx.extractionConflict.create({
          data: { templateId, studyId, fieldId: field.id },
        });
        await audit.record(tx, {
          projectId,
          userId: ctx.userId,
          entityType: "ExtractionConflict",
          entityId: opened.id,
          action: AuditActions.EXTRACTION_CONFLICT_OPENED,
          newValue: { templateId, studyId, fieldId: field.id, fieldKey: field.key },
        });
      } else if (existing.status === "VOIDED") {
        await tx.extractionConflict.update({
          where: { id: existing.id },
          data: { status: "OPEN", openedAt: new Date(), resolvedAt: null },
        });
        // Closest catalog fit — there is no EXTRACTION_CONFLICT_REOPENED action.
        await audit.record(tx, {
          projectId,
          userId: ctx.userId,
          entityType: "ExtractionConflict",
          entityId: existing.id,
          action: AuditActions.EXTRACTION_CONFLICT_OPENED,
          previousValue: { status: "VOIDED" },
          newValue: { status: "OPEN" },
          metadata: { reopened: true, fieldKey: field.key },
        });
      }
      // OPEN stays open; RESOLVED is locked.
    } else if (existing?.status === "OPEN") {
      await tx.extractionConflict.update({
        where: { id: existing.id },
        data: { status: "VOIDED", resolvedAt: new Date() },
      });
      // Closest catalog fit — there is no EXTRACTION_CONFLICT_VOIDED action; metadata marks
      // this as an automatic agreement-void, not a human adjudication.
      await audit.record(tx, {
        projectId,
        userId: ctx.userId,
        entityType: "ExtractionConflict",
        entityId: existing.id,
        action: AuditActions.EXTRACTION_CONFLICT_ADJUDICATED,
        previousValue: { status: "OPEN" },
        newValue: { status: "VOIDED" },
        metadata: { autoVoided: true, trigger: "values_now_agree", fieldKey: field.key },
      });
    }
  }
}

// ---------------------------------------------------------------------------
// Conflicts & adjudication
// ---------------------------------------------------------------------------

export async function listConflicts(
  ctx: Ctx,
  projectId: string,
  filters: { status?: ConflictStatus },
) {
  await requirePermission(ctx, projectId, "extraction.adjudicate");
  const conflicts = await prisma.extractionConflict.findMany({
    where: {
      template: { projectId },
      ...(filters.status ? { status: filters.status } : {}),
    },
    include: {
      field: { select: { id: true, key: true, label: true, type: true, options: true } },
      study: { select: { id: true, label: true } },
      template: { select: { id: true, name: true, version: true } },
      adjudication: { include: { adjudicator: { select: { id: true, name: true } } } },
    },
    orderBy: { openedAt: "asc" },
  });
  if (conflicts.length === 0) return [];

  // One query for all completed forms of the (template, study) pairs involved.
  const pairs = [
    ...new Map(
      conflicts.map((c) => [`${c.templateId}:${c.studyId}`, { templateId: c.templateId, studyId: c.studyId }]),
    ).values(),
  ];
  const forms = await prisma.extractionForm.findMany({
    where: { status: "COMPLETED", OR: pairs },
    include: { extractor: { select: { id: true, name: true } }, values: true },
    orderBy: { completedAt: "asc" },
  });

  return conflicts.map((c) => ({
    ...c,
    forms: forms
      .filter((f) => f.templateId === c.templateId && f.studyId === c.studyId)
      .map((f) => {
        const v = f.values.find((val) => val.fieldId === c.fieldId);
        return {
          formId: f.id,
          extractor: f.extractor,
          value: v?.value ?? null,
          sourceQuote: v?.sourceQuote ?? null,
          pageNumber: v?.pageNumber ?? null,
        };
      }),
  }));
}

export async function adjudicateConflict(
  ctx: Ctx,
  projectId: string,
  conflictId: string,
  input: z.infer<typeof adjudicateConflictSchema>,
) {
  await requirePermission(ctx, projectId, "extraction.adjudicate");
  return prisma.$transaction(async (tx) => {
    const conflictRow = await tx.extractionConflict.findFirst({
      where: { id: conflictId, template: { projectId } },
      include: { field: true },
    });
    if (!conflictRow) throw notFound("Extraction conflict");
    if (conflictRow.status !== "OPEN") {
      throw invalidState("Only open conflicts can be adjudicated");
    }
    const finalValue = validateFieldValue(
      conflictRow.field,
      input.finalValue === undefined ? null : input.finalValue,
    ) as Prisma.InputJsonValue;

    const adjudication = await tx.extractionAdjudication.create({
      data: {
        conflictId: conflictRow.id,
        adjudicatorId: ctx.userId, // always from session — integrity rule 5
        finalValue,
        reason: input.reason,
      },
    });
    const resolved = await tx.extractionConflict.update({
      where: { id: conflictRow.id },
      data: { status: "RESOLVED", resolvedAt: new Date() },
    });
    await audit.record(tx, {
      projectId,
      userId: ctx.userId,
      entityType: "ExtractionConflict",
      entityId: conflictRow.id,
      action: AuditActions.EXTRACTION_CONFLICT_ADJUDICATED,
      previousValue: { status: "OPEN" },
      newValue: { status: "RESOLVED", finalValue },
      reason: input.reason,
      metadata: { fieldKey: conflictRow.field.key, studyId: conflictRow.studyId },
    });
    return { ...resolved, adjudication };
  });
}
