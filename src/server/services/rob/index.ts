// Risk of bias domain service — tools, builder, assignments, assessments, judgments,
// signaling responses, completion-time conflict detection, and adjudication.
//
// Contract highlights (docs/09):
//   R2  — judgments are strings validated against the owning tool's judgmentScale JSON.
//   R9  — by-id loads tenant-scoped; builtin tools (projectId null) readable everywhere but
//         NEVER mutable via project routes (mutation load → NOT_FOUND). Structure freezes
//         once any assessment exists — clone to modify.
//   R15 — bulk assignments (studies × assessors); starting an assessment requires an
//         assignment, or project.edit for an implicit self-assign.

import { z } from "zod";
import type { Prisma } from "@prisma/client";
import { prisma, type Tx } from "@/server/db";
import { forbidden, invalidState, notFound, validationError } from "@/server/errors";
import type { Ctx } from "@/server/auth/session";
import { can, requirePermission } from "@/server/permissions";
import * as audit from "@/server/services/audit";
import { AuditActions } from "@/server/services/audit";
import { DEFAULT_ALLOWED_ANSWERS } from "./builtin";

export { ensureBuiltinGenericTool, DEFAULT_ALLOWED_ANSWERS } from "./builtin";

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

export const judgmentScaleEntrySchema = z.object({
  value: z
    .string()
    .regex(/^[a-z][a-z0-9_]*$/, "scale values must be snake_case identifiers"),
  label: z.string().trim().min(1).max(120),
  color: z.string().trim().max(32).optional(),
  severity: z.number().int().min(1).max(10).optional(),
});

export const createToolSchema = z.object({
  name: z.string().trim().min(2).max(200),
  description: z.string().trim().max(2000).optional(),
  judgmentScale: z
    .array(judgmentScaleEntrySchema)
    .min(2)
    .refine(
      (entries) => new Set(entries.map((e) => e.value)).size === entries.length,
      "judgment scale values must be unique",
    ),
});

export const createDomainSchema = z.object({
  name: z.string().trim().min(1).max(200),
  guidance: z.string().trim().max(5000).optional(),
  order: z.number().int().min(0).optional(),
});

export const updateDomainSchema = z.object({
  name: z.string().trim().min(1).max(200).optional(),
  guidance: z.string().trim().max(5000).nullable().optional(),
  order: z.number().int().min(0).optional(),
});

const allowedAnswersSchema = z
  .array(z.string().trim().min(1).max(40))
  .min(2)
  .refine((a) => new Set(a).size === a.length, "allowed answers must be unique");

export const createQuestionSchema = z.object({
  text: z.string().trim().min(1).max(2000),
  guidance: z.string().trim().max(5000).optional(),
  order: z.number().int().min(0).optional(),
  allowedAnswers: allowedAnswersSchema.optional(),
});

export const updateQuestionSchema = z.object({
  text: z.string().trim().min(1).max(2000).optional(),
  guidance: z.string().trim().max(5000).nullable().optional(),
  order: z.number().int().min(0).optional(),
  allowedAnswers: allowedAnswersSchema.optional(),
});

export const createAssignmentsSchema = z.object({
  toolId: z.string().min(1),
  studyIds: z.array(z.string().min(1)).min(1).max(500),
  assessorIds: z.array(z.string().min(1)).min(1).max(50),
});

export const startAssessmentSchema = z.object({
  toolId: z.string().min(1),
});

export const putJudgmentSchema = z.object({
  judgment: z.string().min(1),
  support: z.string().trim().max(10000).nullable().optional(),
  notes: z.string().trim().max(10000).nullable().optional(),
});

export const putResponseSchema = z.object({
  answer: z.string().min(1),
  note: z.string().trim().max(10000).nullable().optional(),
});

export const updateAssessmentSchema = z.object({
  overallJudgment: z.string().min(1),
});

export const adjudicateConflictSchema = z.object({
  finalJudgment: z.string().min(1),
  reason: z.string().trim().min(3).max(10000),
});

// Query-param filter for GET .../rob/conflicts?status=
export const conflictStatusFilterSchema = z.enum(["OPEN", "RESOLVED", "VOIDED"]).optional();

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export interface JudgmentScaleEntry {
  value: string;
  label: string;
  color?: string;
  severity?: number;
}

function scaleValues(tool: { judgmentScale: Prisma.JsonValue }): string[] {
  const scale = tool.judgmentScale as unknown as JudgmentScaleEntry[];
  return Array.isArray(scale) ? scale.map((e) => e.value) : [];
}

function assertJudgmentInScale(tool: { judgmentScale: Prisma.JsonValue }, judgment: string) {
  const values = scaleValues(tool);
  if (!values.includes(judgment)) {
    throw validationError(`Judgment must be one of the tool's scale values`, {
      allowed: values,
      received: judgment,
    });
  }
}

const TOOL_INCLUDE = {
  domains: {
    orderBy: { order: "asc" as const },
    include: { questions: { orderBy: { order: "asc" as const } } },
  },
};

// Mutation-path load: the tool must BELONG to the project. Builtins (projectId null)
// deliberately miss here → NOT_FOUND (R9: builtins are immutable via project routes).
async function loadMutableTool(tx: Tx, projectId: string, toolId: string) {
  const tool = await tx.riskOfBiasTool.findFirst({ where: { id: toolId, projectId } });
  if (!tool) throw notFound("Risk of bias tool");
  return tool;
}

// Read/consume-path load: project tool OR builtin.
async function loadVisibleTool(tx: Tx, projectId: string, toolId: string) {
  const tool = await tx.riskOfBiasTool.findFirst({
    where: { id: toolId, OR: [{ projectId }, { isBuiltin: true, projectId: null }] },
  });
  if (!tool) throw notFound("Risk of bias tool");
  return tool;
}

async function assertToolNotInUse(tx: Tx, toolId: string) {
  const assessments = await tx.riskOfBiasAssessment.count({ where: { toolId } });
  if (assessments > 0) throw invalidState("tool is in use — clone it to modify");
}

// Tenant-scoped assessment load (scoped through the study's project).
async function loadAssessment(tx: Tx, projectId: string, assessmentId: string) {
  const assessment = await tx.riskOfBiasAssessment.findFirst({
    where: { id: assessmentId, study: { projectId } },
    include: { tool: true },
  });
  if (!assessment) throw notFound("Assessment");
  return assessment;
}

function assertMineAndInProgress(ctx: Ctx, assessment: { assessorId: string; status: string }) {
  if (assessment.assessorId !== ctx.userId) {
    throw forbidden("You can only modify your own assessment");
  }
  if (assessment.status !== "IN_PROGRESS") {
    throw invalidState("Assessment is already completed");
  }
}

// POST-ADJUDICATION LOCK: once a conflict for (study, domain) — or the overall conflict
// (domainId null) — is RESOLVED, further judgment writes on it are rejected.
async function assertNotAdjudicated(
  tx: Tx,
  toolId: string,
  studyId: string,
  domainId: string | null,
) {
  const resolved = await tx.riskOfBiasConflict.findFirst({
    where: { toolId, studyId, domainId, status: "RESOLVED" },
  });
  if (resolved) {
    throw invalidState(
      domainId
        ? "This domain has been adjudicated — judgment is locked"
        : "The overall judgment has been adjudicated — it is locked",
    );
  }
}

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

// Session-only endpoint: the builtin catalog is not project data.
export async function listBuiltinTools(_ctx: Ctx) {
  return prisma.riskOfBiasTool.findMany({
    where: { projectId: null, isBuiltin: true, status: "PUBLISHED" },
    include: TOOL_INCLUDE,
    orderBy: { createdAt: "asc" },
  });
}

export async function listProjectTools(ctx: Ctx, projectId: string) {
  await requirePermission(ctx, projectId, "project.view");
  return prisma.riskOfBiasTool.findMany({
    where: {
      OR: [{ projectId }, { isBuiltin: true, projectId: null, status: "PUBLISHED" }],
    },
    include: TOOL_INCLUDE,
    orderBy: [{ isBuiltin: "desc" }, { createdAt: "asc" }],
  });
}

export async function createTool(
  ctx: Ctx,
  projectId: string,
  input: z.infer<typeof createToolSchema>,
) {
  await requirePermission(ctx, projectId, "rob.tools");
  return prisma.$transaction(async (tx) => {
    const tool = await tx.riskOfBiasTool.create({
      data: {
        projectId,
        name: input.name,
        description: input.description ?? null,
        isBuiltin: false,
        status: "DRAFT",
        judgmentScale: input.judgmentScale,
        createdById: ctx.userId,
      },
    });
    await audit.record(tx, {
      projectId,
      userId: ctx.userId,
      entityType: "RiskOfBiasTool",
      entityId: tool.id,
      action: AuditActions.ROB_TOOL_CREATED,
      newValue: { name: tool.name, judgmentScale: input.judgmentScale },
    });
    return tool;
  });
}

// R9: builtins (and in-use project tools) are consumed by cloning into the project as DRAFT.
export async function cloneTool(ctx: Ctx, projectId: string, toolId: string) {
  await requirePermission(ctx, projectId, "rob.tools");
  return prisma.$transaction(async (tx) => {
    const source = await tx.riskOfBiasTool.findFirst({
      where: { id: toolId, OR: [{ projectId }, { isBuiltin: true, projectId: null }] },
      include: TOOL_INCLUDE,
    });
    if (!source) throw notFound("Risk of bias tool");

    const tool = await tx.riskOfBiasTool.create({
      data: {
        projectId,
        name: source.name,
        description: source.description,
        isBuiltin: false,
        status: "DRAFT",
        judgmentScale: source.judgmentScale as Prisma.InputJsonValue,
        createdById: ctx.userId,
      },
    });
    for (const domain of source.domains) {
      await tx.riskOfBiasDomain.create({
        data: {
          toolId: tool.id,
          name: domain.name,
          guidance: domain.guidance,
          order: domain.order,
          questions: {
            create: domain.questions.map((q) => ({
              text: q.text,
              guidance: q.guidance,
              order: q.order,
              allowedAnswers: q.allowedAnswers as Prisma.InputJsonValue,
            })),
          },
        },
      });
    }
    await audit.record(tx, {
      projectId,
      userId: ctx.userId,
      entityType: "RiskOfBiasTool",
      entityId: tool.id,
      action: AuditActions.ROB_TOOL_CREATED,
      newValue: { name: tool.name },
      metadata: { clonedFrom: source.id, clonedFromBuiltin: source.isBuiltin },
    });
    return tx.riskOfBiasTool.findFirstOrThrow({
      where: { id: tool.id },
      include: TOOL_INCLUDE,
    });
  });
}

export async function publishTool(ctx: Ctx, projectId: string, toolId: string) {
  await requirePermission(ctx, projectId, "rob.tools");
  return prisma.$transaction(async (tx) => {
    const tool = await loadMutableTool(tx, projectId, toolId);
    if (tool.status !== "DRAFT") throw invalidState("Only draft tools can be published");
    const domains = await tx.riskOfBiasDomain.count({ where: { toolId } });
    if (domains < 1) {
      throw invalidState("A tool needs at least one domain before it can be published");
    }
    const updated = await tx.riskOfBiasTool.update({
      where: { id: toolId },
      data: { status: "PUBLISHED" },
    });
    await audit.record(tx, {
      projectId,
      userId: ctx.userId,
      entityType: "RiskOfBiasTool",
      entityId: toolId,
      action: AuditActions.ROB_TOOL_PUBLISHED,
      previousValue: { status: "DRAFT" },
      newValue: { status: "PUBLISHED" },
    });
    return updated;
  });
}

// ---------------------------------------------------------------------------
// Builder: domains & signaling questions (structure frozen once assessed — R9)
// ---------------------------------------------------------------------------

export async function createDomain(
  ctx: Ctx,
  projectId: string,
  toolId: string,
  input: z.infer<typeof createDomainSchema>,
) {
  await requirePermission(ctx, projectId, "rob.tools");
  return prisma.$transaction(async (tx) => {
    await loadMutableTool(tx, projectId, toolId);
    await assertToolNotInUse(tx, toolId);
    const order = input.order ?? (await tx.riskOfBiasDomain.count({ where: { toolId } }));
    const domain = await tx.riskOfBiasDomain.create({
      data: { toolId, name: input.name, guidance: input.guidance ?? null, order },
    });
    await audit.record(tx, {
      projectId,
      userId: ctx.userId,
      entityType: "RiskOfBiasTool",
      entityId: toolId,
      action: AuditActions.ROB_TOOL_UPDATED,
      newValue: { domainId: domain.id, name: domain.name, order: domain.order },
      metadata: { change: "domain_created", domainId: domain.id },
    });
    return domain;
  });
}

export async function updateDomain(
  ctx: Ctx,
  projectId: string,
  toolId: string,
  domainId: string,
  input: z.infer<typeof updateDomainSchema>,
) {
  await requirePermission(ctx, projectId, "rob.tools");
  return prisma.$transaction(async (tx) => {
    await loadMutableTool(tx, projectId, toolId);
    await assertToolNotInUse(tx, toolId);
    const domain = await tx.riskOfBiasDomain.findFirst({ where: { id: domainId, toolId } });
    if (!domain) throw notFound("Domain");
    const updated = await tx.riskOfBiasDomain.update({
      where: { id: domainId },
      data: {
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.guidance !== undefined ? { guidance: input.guidance } : {}),
        ...(input.order !== undefined ? { order: input.order } : {}),
      },
    });
    await audit.record(tx, {
      projectId,
      userId: ctx.userId,
      entityType: "RiskOfBiasTool",
      entityId: toolId,
      action: AuditActions.ROB_TOOL_UPDATED,
      previousValue: { name: domain.name, guidance: domain.guidance, order: domain.order },
      newValue: { name: updated.name, guidance: updated.guidance, order: updated.order },
      metadata: { change: "domain_updated", domainId },
    });
    return updated;
  });
}

export async function deleteDomain(
  ctx: Ctx,
  projectId: string,
  toolId: string,
  domainId: string,
) {
  await requirePermission(ctx, projectId, "rob.tools");
  return prisma.$transaction(async (tx) => {
    await loadMutableTool(tx, projectId, toolId);
    await assertToolNotInUse(tx, toolId);
    const domain = await tx.riskOfBiasDomain.findFirst({ where: { id: domainId, toolId } });
    if (!domain) throw notFound("Domain");
    await tx.riskOfBiasSignalingQuestion.deleteMany({ where: { domainId } });
    await tx.riskOfBiasDomain.delete({ where: { id: domainId } });
    await audit.record(tx, {
      projectId,
      userId: ctx.userId,
      entityType: "RiskOfBiasTool",
      entityId: toolId,
      action: AuditActions.ROB_TOOL_UPDATED,
      previousValue: { domainId, name: domain.name },
      metadata: { change: "domain_deleted", domainId },
    });
    return { deleted: true };
  });
}

export async function createQuestion(
  ctx: Ctx,
  projectId: string,
  toolId: string,
  domainId: string,
  input: z.infer<typeof createQuestionSchema>,
) {
  await requirePermission(ctx, projectId, "rob.tools");
  return prisma.$transaction(async (tx) => {
    await loadMutableTool(tx, projectId, toolId);
    await assertToolNotInUse(tx, toolId);
    const domain = await tx.riskOfBiasDomain.findFirst({ where: { id: domainId, toolId } });
    if (!domain) throw notFound("Domain");
    const order =
      input.order ?? (await tx.riskOfBiasSignalingQuestion.count({ where: { domainId } }));
    const question = await tx.riskOfBiasSignalingQuestion.create({
      data: {
        domainId,
        text: input.text,
        guidance: input.guidance ?? null,
        order,
        allowedAnswers: input.allowedAnswers ?? [...DEFAULT_ALLOWED_ANSWERS],
      },
    });
    await audit.record(tx, {
      projectId,
      userId: ctx.userId,
      entityType: "RiskOfBiasTool",
      entityId: toolId,
      action: AuditActions.ROB_TOOL_UPDATED,
      newValue: { questionId: question.id, text: question.text },
      metadata: { change: "question_created", domainId, questionId: question.id },
    });
    return question;
  });
}

export async function updateQuestion(
  ctx: Ctx,
  projectId: string,
  toolId: string,
  domainId: string,
  questionId: string,
  input: z.infer<typeof updateQuestionSchema>,
) {
  await requirePermission(ctx, projectId, "rob.tools");
  return prisma.$transaction(async (tx) => {
    await loadMutableTool(tx, projectId, toolId);
    await assertToolNotInUse(tx, toolId);
    const question = await tx.riskOfBiasSignalingQuestion.findFirst({
      where: { id: questionId, domainId, domain: { toolId } },
    });
    if (!question) throw notFound("Signaling question");
    const updated = await tx.riskOfBiasSignalingQuestion.update({
      where: { id: questionId },
      data: {
        ...(input.text !== undefined ? { text: input.text } : {}),
        ...(input.guidance !== undefined ? { guidance: input.guidance } : {}),
        ...(input.order !== undefined ? { order: input.order } : {}),
        ...(input.allowedAnswers !== undefined
          ? { allowedAnswers: input.allowedAnswers }
          : {}),
      },
    });
    await audit.record(tx, {
      projectId,
      userId: ctx.userId,
      entityType: "RiskOfBiasTool",
      entityId: toolId,
      action: AuditActions.ROB_TOOL_UPDATED,
      previousValue: { text: question.text, allowedAnswers: question.allowedAnswers },
      newValue: { text: updated.text, allowedAnswers: updated.allowedAnswers },
      metadata: { change: "question_updated", domainId, questionId },
    });
    return updated;
  });
}

export async function deleteQuestion(
  ctx: Ctx,
  projectId: string,
  toolId: string,
  domainId: string,
  questionId: string,
) {
  await requirePermission(ctx, projectId, "rob.tools");
  return prisma.$transaction(async (tx) => {
    await loadMutableTool(tx, projectId, toolId);
    await assertToolNotInUse(tx, toolId);
    const question = await tx.riskOfBiasSignalingQuestion.findFirst({
      where: { id: questionId, domainId, domain: { toolId } },
    });
    if (!question) throw notFound("Signaling question");
    await tx.riskOfBiasSignalingQuestion.delete({ where: { id: questionId } });
    await audit.record(tx, {
      projectId,
      userId: ctx.userId,
      entityType: "RiskOfBiasTool",
      entityId: toolId,
      action: AuditActions.ROB_TOOL_UPDATED,
      previousValue: { questionId, text: question.text },
      metadata: { change: "question_deleted", domainId, questionId },
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
    const tool = await loadVisibleTool(tx, projectId, input.toolId);
    if (tool.status !== "PUBLISHED") {
      throw invalidState("Tool must be published before it can be assigned");
    }

    const studyIds = [...new Set(input.studyIds)];
    const assessorIds = [...new Set(input.assessorIds)];

    // R9: body-supplied FKs must belong to the project.
    const studies = await tx.study.findMany({
      where: { id: { in: studyIds }, projectId },
      select: { id: true },
    });
    if (studies.length !== studyIds.length) throw notFound("Study");

    // Assessors must be ACTIVE project members holding rob.assess.
    const members = await tx.projectMember.findMany({
      where: { projectId, userId: { in: assessorIds }, status: "ACTIVE" },
    });
    const byUser = new Map(members.map((m) => [m.userId, m]));
    for (const assessorId of assessorIds) {
      const member = byUser.get(assessorId);
      if (!member || !can(member.roles, "rob.assess")) {
        throw validationError("All assessors must be active project members who can assess", {
          assessorId,
        });
      }
    }

    const existing = await tx.riskOfBiasAssignment.findMany({
      where: {
        toolId: tool.id,
        studyId: { in: studyIds },
        assessorId: { in: assessorIds },
      },
      select: { studyId: true, assessorId: true },
    });
    const existingKeys = new Set(existing.map((a) => `${a.studyId}:${a.assessorId}`));

    const created = [];
    let skipped = 0;
    for (const studyId of studyIds) {
      for (const assessorId of assessorIds) {
        if (existingKeys.has(`${studyId}:${assessorId}`)) {
          skipped += 1;
          continue;
        }
        const assignment = await tx.riskOfBiasAssignment.create({
          data: { toolId: tool.id, studyId, assessorId },
        });
        await audit.record(tx, {
          projectId,
          userId: ctx.userId,
          entityType: "RiskOfBiasAssignment",
          entityId: assignment.id,
          action: AuditActions.ROB_ASSIGNED,
          newValue: { toolId: tool.id, studyId, assessorId },
        });
        created.push(assignment);
      }
    }
    return { created, skipped };
  });
}

export async function listAssignments(
  ctx: Ctx,
  projectId: string,
  options: { mine?: boolean } = {},
) {
  if (options.mine) {
    await requirePermission(ctx, projectId, "project.view");
  } else {
    // Listing everyone's assignments is an orchestration view.
    await requirePermission(ctx, projectId, "project.edit");
  }
  return prisma.riskOfBiasAssignment.findMany({
    where: {
      study: { projectId },
      ...(options.mine ? { assessorId: ctx.userId } : {}),
    },
    include: {
      tool: { select: { id: true, name: true, isBuiltin: true } },
      study: { select: { id: true, label: true } },
      assessor: { select: { id: true, name: true } },
    },
    orderBy: { createdAt: "asc" },
  });
}

// ---------------------------------------------------------------------------
// Assessments
// ---------------------------------------------------------------------------

export async function startAssessment(
  ctx: Ctx,
  projectId: string,
  studyId: string,
  input: z.infer<typeof startAssessmentSchema>,
) {
  const member = await requirePermission(ctx, projectId, "rob.assess");
  const study = await prisma.study.findFirst({ where: { id: studyId, projectId } });
  if (!study) throw notFound("Study");

  return prisma.$transaction(async (tx) => {
    const tool = await loadVisibleTool(tx, projectId, input.toolId);
    if (tool.status !== "PUBLISHED") {
      throw invalidState("Tool must be published before assessments can start");
    }

    // Idempotent start: (tool, study, assessor) is unique — return the existing one.
    const existing = await tx.riskOfBiasAssessment.findUnique({
      where: {
        toolId_studyId_assessorId: {
          toolId: tool.id,
          studyId,
          assessorId: ctx.userId,
        },
      },
    });
    if (existing) return existing;

    // R15: assignment required; project.edit holders may self-assign implicitly.
    const assignment = await tx.riskOfBiasAssignment.findUnique({
      where: {
        toolId_studyId_assessorId: {
          toolId: tool.id,
          studyId,
          assessorId: ctx.userId,
        },
      },
    });
    const hasAssignment = assignment !== null && assignment.status !== "VOIDED";
    if (!hasAssignment) {
      if (!can(member.roles, "project.edit")) {
        throw forbidden("You are not assigned to assess this study with this tool");
      }
      const selfAssignment =
        assignment ??
        (await tx.riskOfBiasAssignment.create({
          data: { toolId: tool.id, studyId, assessorId: ctx.userId },
        }));
      if (assignment?.status === "VOIDED") {
        await tx.riskOfBiasAssignment.update({
          where: { id: assignment.id },
          data: { status: "PENDING" },
        });
      }
      await audit.record(tx, {
        projectId,
        userId: ctx.userId,
        entityType: "RiskOfBiasAssignment",
        entityId: selfAssignment.id,
        action: AuditActions.ROB_ASSIGNED,
        newValue: { toolId: tool.id, studyId, assessorId: ctx.userId },
        metadata: { implicit: true },
      });
    }

    const assessment = await tx.riskOfBiasAssessment.create({
      data: { toolId: tool.id, studyId, assessorId: ctx.userId },
    });
    await audit.record(tx, {
      projectId,
      userId: ctx.userId,
      entityType: "RiskOfBiasAssessment",
      entityId: assessment.id,
      action: AuditActions.ROB_ASSESSMENT_STARTED,
      newValue: { toolId: tool.id, studyId, assessorId: ctx.userId },
    });
    return assessment;
  });
}

// Blind rule: everyone sees their own assessments; seeing co-assessors' work requires
// rob.adjudicate or project.edit (mirrors R1's static audit visibility rule).
export async function listAssessments(
  ctx: Ctx,
  projectId: string,
  filters: { studyId?: string; toolId?: string } = {},
) {
  const member = await requirePermission(ctx, projectId, "project.view");
  const seesAll = can(member.roles, "rob.adjudicate") || can(member.roles, "project.edit");
  return prisma.riskOfBiasAssessment.findMany({
    where: {
      study: { projectId },
      ...(filters.studyId ? { studyId: filters.studyId } : {}),
      ...(filters.toolId ? { toolId: filters.toolId } : {}),
      ...(seesAll ? {} : { assessorId: ctx.userId }),
    },
    include: {
      tool: { select: { id: true, name: true, judgmentScale: true } },
      study: { select: { id: true, label: true } },
      assessor: { select: { id: true, name: true } },
      judgments: true,
      responses: true,
    },
    orderBy: { createdAt: "asc" },
  });
}

export async function putJudgment(
  ctx: Ctx,
  projectId: string,
  assessmentId: string,
  domainId: string,
  input: z.infer<typeof putJudgmentSchema>,
) {
  await requirePermission(ctx, projectId, "rob.assess");
  return prisma.$transaction(async (tx) => {
    const assessment = await loadAssessment(tx, projectId, assessmentId);
    assertMineAndInProgress(ctx, assessment);

    const domain = await tx.riskOfBiasDomain.findFirst({
      where: { id: domainId, toolId: assessment.toolId },
    });
    if (!domain) throw notFound("Domain");

    assertJudgmentInScale(assessment.tool, input.judgment);
    await assertNotAdjudicated(tx, assessment.toolId, assessment.studyId, domainId);

    const existing = await tx.riskOfBiasJudgment.findUnique({
      where: { assessmentId_domainId: { assessmentId, domainId } },
    });
    if (existing) {
      const updated = await tx.riskOfBiasJudgment.update({
        where: { id: existing.id },
        data: {
          judgment: input.judgment,
          support: input.support !== undefined ? input.support : existing.support,
          notes: input.notes !== undefined ? input.notes : existing.notes,
        },
      });
      await audit.record(tx, {
        projectId,
        userId: ctx.userId,
        entityType: "RiskOfBiasJudgment",
        entityId: existing.id,
        action: AuditActions.ROB_JUDGMENT_UPDATED,
        previousValue: { judgment: existing.judgment, support: existing.support },
        newValue: { judgment: updated.judgment, support: updated.support },
        metadata: { assessmentId, domainId },
      });
      return updated;
    }
    const judgment = await tx.riskOfBiasJudgment.create({
      data: {
        assessmentId,
        domainId,
        judgment: input.judgment,
        support: input.support ?? null,
        notes: input.notes ?? null,
      },
    });
    await audit.record(tx, {
      projectId,
      userId: ctx.userId,
      entityType: "RiskOfBiasJudgment",
      entityId: judgment.id,
      action: AuditActions.ROB_JUDGMENT_CREATED,
      newValue: { judgment: judgment.judgment, support: judgment.support },
      metadata: { assessmentId, domainId },
    });
    return judgment;
  });
}

// NOTE: no dedicated audit action exists for signaling responses (see actions.ts) —
// responses are intentionally NOT audited (flagged in the build report).
export async function putResponse(
  ctx: Ctx,
  projectId: string,
  assessmentId: string,
  questionId: string,
  input: z.infer<typeof putResponseSchema>,
) {
  await requirePermission(ctx, projectId, "rob.assess");
  return prisma.$transaction(async (tx) => {
    const assessment = await loadAssessment(tx, projectId, assessmentId);
    assertMineAndInProgress(ctx, assessment);

    const question = await tx.riskOfBiasSignalingQuestion.findFirst({
      where: { id: questionId, domain: { toolId: assessment.toolId } },
    });
    if (!question) throw notFound("Signaling question");

    const allowed = Array.isArray(question.allowedAnswers)
      ? (question.allowedAnswers as string[])
      : [];
    if (!allowed.includes(input.answer)) {
      throw validationError("Answer must be one of the question's allowed answers", {
        allowed,
        received: input.answer,
      });
    }
    await assertNotAdjudicated(tx, assessment.toolId, assessment.studyId, question.domainId);

    return tx.riskOfBiasSignalingResponse.upsert({
      where: { assessmentId_questionId: { assessmentId, questionId } },
      create: { assessmentId, questionId, answer: input.answer, note: input.note ?? null },
      update: {
        answer: input.answer,
        ...(input.note !== undefined ? { note: input.note } : {}),
      },
    });
  });
}

export async function updateAssessment(
  ctx: Ctx,
  projectId: string,
  assessmentId: string,
  input: z.infer<typeof updateAssessmentSchema>,
) {
  await requirePermission(ctx, projectId, "rob.assess");
  return prisma.$transaction(async (tx) => {
    const assessment = await loadAssessment(tx, projectId, assessmentId);
    assertMineAndInProgress(ctx, assessment);
    assertJudgmentInScale(assessment.tool, input.overallJudgment);
    await assertNotAdjudicated(tx, assessment.toolId, assessment.studyId, null);

    const updated = await tx.riskOfBiasAssessment.update({
      where: { id: assessmentId },
      data: { overallJudgment: input.overallJudgment },
    });
    // Closest-fit action: no ROB_ASSESSMENT_UPDATED exists in the audit catalog.
    await audit.record(tx, {
      projectId,
      userId: ctx.userId,
      entityType: "RiskOfBiasAssessment",
      entityId: assessmentId,
      action: assessment.overallJudgment
        ? AuditActions.ROB_JUDGMENT_UPDATED
        : AuditActions.ROB_JUDGMENT_CREATED,
      previousValue: assessment.overallJudgment
        ? { overallJudgment: assessment.overallJudgment }
        : undefined,
      newValue: { overallJudgment: updated.overallJudgment },
      metadata: { overall: true },
    });
    return updated;
  });
}

// ---------------------------------------------------------------------------
// Completion + conflict detection (same transaction — R15)
// ---------------------------------------------------------------------------

export async function completeAssessment(ctx: Ctx, projectId: string, assessmentId: string) {
  await requirePermission(ctx, projectId, "rob.assess");
  return prisma.$transaction(async (tx) => {
    const assessment = await loadAssessment(tx, projectId, assessmentId);
    assertMineAndInProgress(ctx, assessment);

    const domains = await tx.riskOfBiasDomain.findMany({
      where: { toolId: assessment.toolId },
      orderBy: { order: "asc" },
    });
    const judgments = await tx.riskOfBiasJudgment.findMany({ where: { assessmentId } });
    const judged = new Set(judgments.map((j) => j.domainId));
    const missing = domains.filter((d) => !judged.has(d.id)).map((d) => d.name);
    if (missing.length > 0) {
      throw validationError("Every domain needs a judgment before completing", {
        missingDomains: missing,
      });
    }

    const completed = await tx.riskOfBiasAssessment.update({
      where: { id: assessmentId },
      data: { status: "COMPLETED", completedAt: new Date() },
    });
    await tx.riskOfBiasAssignment.updateMany({
      where: {
        toolId: assessment.toolId,
        studyId: assessment.studyId,
        assessorId: ctx.userId,
        status: "PENDING",
      },
      data: { status: "COMPLETED" },
    });
    await audit.record(tx, {
      projectId,
      userId: ctx.userId,
      entityType: "RiskOfBiasAssessment",
      entityId: assessmentId,
      action: AuditActions.ROB_ASSESSMENT_COMPLETED,
      newValue: { toolId: assessment.toolId, studyId: assessment.studyId },
    });

    await detectConflicts(tx, ctx, projectId, assessment.toolId, assessment.studyId, domains);
    return completed;
  });
}

// Conflict detection (R15): with ≥2 COMPLETED assessments for (tool, study), compare
// domain-by-domain and the overall judgment. Disagreement opens (or reopens a VOIDED)
// conflict; agreement voids an OPEN one. RESOLVED conflicts are never touched.
// The overall conflict (domainId null) is service-enforced unique per (study, tool) via
// query-before-create inside this transaction (Postgres NULLs are distinct in unique indexes).
async function detectConflicts(
  tx: Tx,
  ctx: Ctx,
  projectId: string,
  toolId: string,
  studyId: string,
  domains: { id: string; name: string }[],
) {
  const completed = await tx.riskOfBiasAssessment.findMany({
    where: { toolId, studyId, status: "COMPLETED" },
    include: { judgments: true },
  });
  if (completed.length < 2) return;

  const openOrReopen = async (domainId: string | null) => {
    const existing = await tx.riskOfBiasConflict.findFirst({
      where: { toolId, studyId, domainId },
    });
    if (existing) {
      if (existing.status !== "VOIDED") return; // OPEN stays open; RESOLVED stays resolved
      await tx.riskOfBiasConflict.update({
        where: { id: existing.id },
        data: { status: "OPEN", openedAt: new Date(), resolvedAt: null },
      });
      await audit.record(tx, {
        projectId,
        userId: ctx.userId,
        entityType: "RiskOfBiasConflict",
        entityId: existing.id,
        action: AuditActions.ROB_CONFLICT_OPENED,
        newValue: { toolId, studyId, domainId },
        metadata: { reopenedFromVoided: true },
      });
      return;
    }
    const conflict = await tx.riskOfBiasConflict.create({
      data: { toolId, studyId, domainId },
    });
    await audit.record(tx, {
      projectId,
      userId: ctx.userId,
      entityType: "RiskOfBiasConflict",
      entityId: conflict.id,
      action: AuditActions.ROB_CONFLICT_OPENED,
      newValue: { toolId, studyId, domainId },
    });
  };

  // Now-agreeing + OPEN → VOIDED (no dedicated audit action exists for voiding).
  const voidIfOpen = async (domainId: string | null) => {
    await tx.riskOfBiasConflict.updateMany({
      where: { toolId, studyId, domainId, status: "OPEN" },
      data: { status: "VOIDED", resolvedAt: new Date() },
    });
  };

  for (const domain of domains) {
    const domainJudgments = completed
      .map((a) => a.judgments.find((j) => j.domainId === domain.id)?.judgment)
      .filter((j): j is string => j !== undefined);
    if (domainJudgments.length < 2) continue;
    const distinct = new Set(domainJudgments);
    if (distinct.size > 1) await openOrReopen(domain.id);
    else await voidIfOpen(domain.id);
  }

  const overalls = completed
    .map((a) => a.overallJudgment)
    .filter((j): j is string => j !== null);
  if (overalls.length >= 2) {
    const distinct = new Set(overalls);
    if (distinct.size > 1) await openOrReopen(null);
    else await voidIfOpen(null);
  }
}

// ---------------------------------------------------------------------------
// Conflicts & adjudication
// ---------------------------------------------------------------------------

export async function listConflicts(
  ctx: Ctx,
  projectId: string,
  filters: { status?: "OPEN" | "RESOLVED" | "VOIDED" } = {},
) {
  await requirePermission(ctx, projectId, "rob.adjudicate");
  const conflicts = await prisma.riskOfBiasConflict.findMany({
    where: {
      study: { projectId },
      ...(filters.status ? { status: filters.status } : {}),
    },
    include: {
      tool: { select: { id: true, name: true, judgmentScale: true } },
      study: { select: { id: true, label: true } },
      domain: { select: { id: true, name: true } },
      adjudication: {
        include: { adjudicator: { select: { id: true, name: true } } },
      },
    },
    orderBy: { openedAt: "asc" },
  });

  // Batch-load the COMPLETED assessments backing every conflict's (tool, study) pair.
  const pairKeys = new Set<string>();
  const pairs: { toolId: string; studyId: string }[] = [];
  for (const c of conflicts) {
    const key = `${c.toolId}:${c.studyId}`;
    if (!pairKeys.has(key)) {
      pairKeys.add(key);
      pairs.push({ toolId: c.toolId, studyId: c.studyId });
    }
  }
  const assessments =
    pairs.length === 0
      ? []
      : await prisma.riskOfBiasAssessment.findMany({
          where: { status: "COMPLETED", OR: pairs },
          include: {
            assessor: { select: { id: true, name: true } },
            judgments: true,
          },
        });

  return conflicts.map((conflict) => {
    const related = assessments.filter(
      (a) => a.toolId === conflict.toolId && a.studyId === conflict.studyId,
    );
    const assessors = related.map((a) => {
      if (conflict.domainId === null) {
        return { userId: a.assessor.id, name: a.assessor.name, judgment: a.overallJudgment, support: null };
      }
      const judgment = a.judgments.find((j) => j.domainId === conflict.domainId);
      return {
        userId: a.assessor.id,
        name: a.assessor.name,
        judgment: judgment?.judgment ?? null,
        support: judgment?.support ?? null,
      };
    });
    return {
      id: conflict.id,
      toolId: conflict.toolId,
      studyId: conflict.studyId,
      domainId: conflict.domainId,
      domainName: conflict.domain?.name ?? "Overall",
      status: conflict.status,
      openedAt: conflict.openedAt,
      resolvedAt: conflict.resolvedAt,
      tool: { id: conflict.tool.id, name: conflict.tool.name },
      study: conflict.study,
      assessors,
      adjudication: conflict.adjudication,
    };
  });
}

export async function adjudicateConflict(
  ctx: Ctx,
  projectId: string,
  conflictId: string,
  input: z.infer<typeof adjudicateConflictSchema>,
) {
  await requirePermission(ctx, projectId, "rob.adjudicate");
  return prisma.$transaction(async (tx) => {
    const conflict = await tx.riskOfBiasConflict.findFirst({
      where: { id: conflictId, study: { projectId } },
      include: { tool: true, domain: { select: { name: true } } },
    });
    if (!conflict) throw notFound("Conflict");
    if (conflict.status !== "OPEN") {
      throw invalidState("Only open conflicts can be adjudicated");
    }
    assertJudgmentInScale(conflict.tool, input.finalJudgment);

    const adjudication = await tx.riskOfBiasAdjudication.create({
      data: {
        conflictId,
        adjudicatorId: ctx.userId,
        finalJudgment: input.finalJudgment,
        reason: input.reason,
      },
    });
    await tx.riskOfBiasConflict.update({
      where: { id: conflictId },
      data: { status: "RESOLVED", resolvedAt: new Date() },
    });
    await audit.record(tx, {
      projectId,
      userId: ctx.userId,
      entityType: "RiskOfBiasConflict",
      entityId: conflictId,
      action: AuditActions.ROB_CONFLICT_ADJUDICATED,
      newValue: {
        finalJudgment: input.finalJudgment,
        domainId: conflict.domainId,
        domainName: conflict.domain?.name ?? "Overall",
      },
      reason: input.reason,
      metadata: { adjudicationId: adjudication.id },
    });
    return adjudication;
  });
}
