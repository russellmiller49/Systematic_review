// Projects domain service — project lifecycle, project membership, invitations (R10/R11).
// Follows the exemplar shape in src/server/services/orgs/index.ts:
//   - zod schemas exported for route handlers
//   - ctx first argument; actor identity ONLY from ctx
//   - authorization first, then invariants, then mutation inside prisma.$transaction
//   - audit.record(tx, ...) in the SAME transaction as every mutation
//   - by-id loads tenant-scoped (R9) → notFound on mismatch

import { randomBytes } from "node:crypto";
import { z } from "zod";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/server/db";
import { conflict, forbidden, invalidState, notFound } from "@/server/errors";
import type { Ctx } from "@/server/auth/session";
import { getOrgMembership, requirePermission } from "@/server/permissions";
import * as audit from "@/server/services/audit";
import { AuditActions } from "@/server/services/audit";
import { getAiConfig } from "@/server/ai/config";

const INVITATION_TTL_MS = 14 * 24 * 60 * 60 * 1000; // 14 days

const reviewTypeEnum = z.enum([
  "SYSTEMATIC_REVIEW",
  "SYSTEMATIC_REVIEW_META_ANALYSIS",
  "DIAGNOSTIC_TEST_ACCURACY",
  "SCOPING_REVIEW",
  "RAPID_REVIEW",
  "LIVING_SYSTEMATIC_REVIEW",
  "GUIDELINE_EVIDENCE_REVIEW",
]);

const projectStatusEnum = z.enum([
  "PLANNING",
  "SCREENING",
  "EXTRACTION",
  "ANALYSIS",
  "COMPLETED",
  "ARCHIVED",
]);

const projectRoleEnum = z.enum([
  "OWNER",
  "ADMIN",
  "REVIEWER",
  "ADJUDICATOR",
  "EXTRACTOR",
  "STATISTICIAN",
  "LIBRARIAN",
  "PANEL_MEMBER",
  "TRAINEE",
  "OBSERVER",
]);

// Project creation wizard payload. Screening configuration is applied to BOTH stages
// (title/abstract and full text); stages can be tuned individually afterwards.
export const createProjectSchema = z.object({
  title: z.string().trim().min(2).max(300),
  reviewType: reviewTypeEnum,
  researchQuestion: z.string().trim().max(2000).optional(),
  description: z.string().trim().max(5000).optional(),
  status: projectStatusEnum.default("PLANNING"),
  registrationPlatform: z.string().trim().max(120).optional(),
  registrationId: z.string().trim().max(120).optional(),
  dualScreening: z.boolean().default(true),
  reviewersPerCitation: z.number().int().min(1).max(3).default(2),
  blindedScreening: z.boolean().default(true),
});

export const updateProjectSchema = z.object({
  title: z.string().trim().min(2).max(300).optional(),
  reviewType: reviewTypeEnum.optional(),
  researchQuestion: z.string().trim().max(2000).nullable().optional(),
  description: z.string().trim().max(5000).nullable().optional(),
  status: projectStatusEnum.optional(),
  registrationPlatform: z.string().trim().max(120).nullable().optional(),
  registrationId: z.string().trim().max(120).nullable().optional(),
});

export const addProjectMemberSchema = z.object({
  email: z.string().email(),
  roles: z.array(projectRoleEnum).min(1),
});

export const updateProjectMemberRolesSchema = z.object({
  roles: z.array(projectRoleEnum).min(1),
});

export const createInvitationSchema = z.object({
  email: z.string().email(),
  roles: z.array(projectRoleEnum).min(1),
});

// Everything except `token` — R11: the token is returned ONLY by the create call.
const invitationPublicSelect = {
  id: true,
  projectId: true,
  email: true,
  roles: true,
  invitedById: true,
  expiresAt: true,
  acceptedAt: true,
  revokedAt: true,
  createdAt: true,
  invitedBy: { select: { id: true, name: true, email: true } },
} satisfies Prisma.ProjectInvitationSelect;

// ---------------------------------------------------------------------------
// Projects
// ---------------------------------------------------------------------------

// Any ACTIVE org member (any org role) can create a project in the org.
export async function createProject(
  ctx: Ctx,
  orgId: string,
  rawInput: z.input<typeof createProjectSchema>,
) {
  const membership = await getOrgMembership(ctx.userId, orgId);
  if (!membership) throw notFound("Organization");
  const input = createProjectSchema.parse(rawInput);

  const reviewersPerCitation = input.dualScreening ? input.reviewersPerCitation : 1;

  return prisma.$transaction(async (tx) => {
    const project = await tx.project.create({
      data: {
        orgId,
        title: input.title,
        reviewType: input.reviewType,
        researchQuestion: input.researchQuestion ?? null,
        description: input.description ?? null,
        status: input.status,
        registrationPlatform: input.registrationPlatform ?? null,
        registrationId: input.registrationId ?? null,
        createdById: ctx.userId,
      },
    });
    await tx.projectMember.create({
      data: { projectId: project.id, userId: ctx.userId, roles: ["OWNER"] },
    });
    const stageConfig = {
      reviewersPerCitation,
      blinded: input.blindedScreening,
      maybeGeneratesConflict: true,
    };
    const titleAbstract = await tx.screeningStage.create({
      data: { projectId: project.id, type: "TITLE_ABSTRACT", ...stageConfig },
    });
    const fullText = await tx.screeningStage.create({
      data: { projectId: project.id, type: "FULL_TEXT", ...stageConfig },
    });
    await tx.protocol.create({ data: { projectId: project.id } });
    await audit.record(tx, {
      projectId: project.id,
      userId: ctx.userId,
      entityType: "Project",
      entityId: project.id,
      action: AuditActions.PROJECT_CREATED,
      newValue: {
        orgId,
        title: project.title,
        reviewType: project.reviewType,
        status: project.status,
        dualScreening: input.dualScreening,
        reviewersPerCitation,
        blindedScreening: input.blindedScreening,
      },
    });
    return { ...project, screeningStages: [titleAbstract, fullText] };
  });
}

// Org members see all projects in the org, with headline counts.
export async function listProjects(ctx: Ctx, orgId: string) {
  const membership = await getOrgMembership(ctx.userId, orgId);
  if (!membership) throw notFound("Organization");
  return prisma.project.findMany({
    where: { orgId },
    include: {
      _count: {
        select: {
          citations: true,
          members: { where: { status: "ACTIVE" } },
        },
      },
    },
    orderBy: { createdAt: "asc" },
  });
}

export async function getProject(ctx: Ctx, projectId: string) {
  const member = await requirePermission(ctx, projectId, "project.view");
  const project = await prisma.project.findUnique({
    where: { id: projectId },
    include: {
      org: { select: { id: true, name: true, slug: true } },
      screeningStages: { orderBy: { type: "asc" } },
      _count: {
        select: {
          citations: true,
          members: { where: { status: "ACTIVE" } },
        },
      },
    },
  });
  if (!project) throw notFound("Project");
  // AI feature status for UI gating (model names are not secrets; the key never leaves
  // the server). enabled=false hides every AI affordance client-side.
  const aiConfig = getAiConfig();
  return {
    ...project,
    myRoles: member.roles,
    ai: {
      enabled: aiConfig.enabled,
      provider: aiConfig.provider,
      screeningModel: aiConfig.screeningModel,
      extractionModel: aiConfig.extractionModel,
    },
  };
}

export async function updateProject(
  ctx: Ctx,
  projectId: string,
  input: z.infer<typeof updateProjectSchema>,
) {
  await requirePermission(ctx, projectId, "project.edit");
  return prisma.$transaction(async (tx) => {
    const before = await tx.project.findUniqueOrThrow({ where: { id: projectId } });
    const project = await tx.project.update({ where: { id: projectId }, data: input });

    // Audit only the fields that actually changed, with previous/new values.
    const fields = [
      "title",
      "reviewType",
      "researchQuestion",
      "description",
      "status",
      "registrationPlatform",
      "registrationId",
    ] as const;
    const previousValue: Record<string, unknown> = {};
    const newValue: Record<string, unknown> = {};
    for (const field of fields) {
      if (input[field] === undefined) continue;
      if (before[field] !== project[field]) {
        previousValue[field] = before[field];
        newValue[field] = project[field];
      }
    }
    if (Object.keys(newValue).length > 0) {
      await audit.record(tx, {
        projectId,
        userId: ctx.userId,
        entityType: "Project",
        entityId: projectId,
        action: AuditActions.PROJECT_UPDATED,
        previousValue,
        newValue,
      });
    }
    return project;
  });
}

// ---------------------------------------------------------------------------
// Project members
// ---------------------------------------------------------------------------

export async function listProjectMembers(ctx: Ctx, projectId: string) {
  await requirePermission(ctx, projectId, "project.view");
  return prisma.projectMember.findMany({
    where: { projectId },
    include: { user: { select: { id: true, name: true, email: true } } },
    orderBy: { createdAt: "asc" },
  });
}

// Adds an EXISTING user (by email) who is already an ACTIVE member of the project's org (R10).
export async function addProjectMember(
  ctx: Ctx,
  projectId: string,
  input: z.infer<typeof addProjectMemberSchema>,
) {
  await requirePermission(ctx, projectId, "project.members");
  const email = input.email.toLowerCase().trim();
  return prisma.$transaction(async (tx) => {
    const project = await tx.project.findUniqueOrThrow({
      where: { id: projectId },
      select: { orgId: true },
    });
    const user = await tx.user.findUnique({ where: { email } });
    if (!user) throw notFound("User with this email");
    const orgMember = await getOrgMembership(user.id, project.orgId, tx);
    if (!orgMember) {
      throw invalidState(
        "User must be an active member of the project's organization first — add them to the organization, or send a project invitation",
      );
    }
    const existing = await tx.projectMember.findUnique({
      where: { projectId_userId: { projectId, userId: user.id } },
    });
    if (existing?.status === "ACTIVE") throw conflict("Already a member of this project");
    const member = existing
      ? await tx.projectMember.update({
          where: { id: existing.id },
          data: { status: "ACTIVE", roles: input.roles },
        })
      : await tx.projectMember.create({
          data: { projectId, userId: user.id, roles: input.roles },
        });
    await audit.record(tx, {
      projectId,
      userId: ctx.userId,
      entityType: "ProjectMember",
      entityId: member.id,
      action: AuditActions.MEMBER_ADDED,
      newValue: { userId: user.id, roles: member.roles },
      metadata: existing ? { reactivated: true } : undefined,
    });
    return member;
  });
}

export async function updateProjectMemberRoles(
  ctx: Ctx,
  projectId: string,
  targetUserId: string,
  input: z.infer<typeof updateProjectMemberRolesSchema>,
) {
  await requirePermission(ctx, projectId, "project.members");
  return prisma.$transaction(async (tx) => {
    const member = await tx.projectMember.findFirst({
      where: { projectId, userId: targetUserId, status: "ACTIVE" },
    });
    if (!member) throw notFound("Member");
    if (member.roles.includes("OWNER") && !input.roles.includes("OWNER")) {
      const owners = await tx.projectMember.count({
        where: { projectId, status: "ACTIVE", roles: { has: "OWNER" } },
      });
      if (owners <= 1) throw invalidState("A project must keep at least one owner");
    }
    const updated = await tx.projectMember.update({
      where: { id: member.id },
      data: { roles: input.roles },
    });
    await audit.record(tx, {
      projectId,
      userId: ctx.userId,
      entityType: "ProjectMember",
      entityId: member.id,
      action: AuditActions.MEMBER_ROLES_CHANGED,
      previousValue: { roles: member.roles },
      newValue: { roles: updated.roles },
    });
    return updated;
  });
}

// Soft removal — status flip only. The member's decisions/forms stay attributed forever.
export async function removeProjectMember(ctx: Ctx, projectId: string, targetUserId: string) {
  await requirePermission(ctx, projectId, "project.members");
  return prisma.$transaction(async (tx) => {
    const member = await tx.projectMember.findFirst({
      where: { projectId, userId: targetUserId, status: "ACTIVE" },
    });
    if (!member) throw notFound("Member");
    if (member.roles.includes("OWNER")) {
      const owners = await tx.projectMember.count({
        where: { projectId, status: "ACTIVE", roles: { has: "OWNER" } },
      });
      if (owners <= 1) throw invalidState("A project must keep at least one owner");
    }
    const updated = await tx.projectMember.update({
      where: { id: member.id },
      data: { status: "REMOVED" },
    });
    await audit.record(tx, {
      projectId,
      userId: ctx.userId,
      entityType: "ProjectMember",
      entityId: member.id,
      action: AuditActions.MEMBER_REMOVED,
      previousValue: { roles: member.roles, status: "ACTIVE" },
      newValue: { status: "REMOVED" },
    });
    return updated;
  });
}

// ---------------------------------------------------------------------------
// Invitations (R11)
// ---------------------------------------------------------------------------

// The ONLY call that ever returns the token — hand it to the invitee out of band.
export async function createInvitation(
  ctx: Ctx,
  projectId: string,
  input: z.infer<typeof createInvitationSchema>,
) {
  await requirePermission(ctx, projectId, "project.members");
  const email = input.email.toLowerCase().trim();
  const token = randomBytes(32).toString("base64url");
  const expiresAt = new Date(Date.now() + INVITATION_TTL_MS);
  return prisma.$transaction(async (tx) => {
    const invitation = await tx.projectInvitation.create({
      data: {
        projectId,
        email,
        roles: input.roles,
        token,
        invitedById: ctx.userId,
        expiresAt,
      },
    });
    await audit.record(tx, {
      projectId,
      userId: ctx.userId,
      entityType: "ProjectInvitation",
      entityId: invitation.id,
      action: AuditActions.INVITATION_CREATED,
      newValue: { email, roles: input.roles, expiresAt },
    });
    return invitation; // includes token — create response only
  });
}

export async function listInvitations(ctx: Ctx, projectId: string) {
  await requirePermission(ctx, projectId, "project.members");
  return prisma.projectInvitation.findMany({
    where: { projectId },
    select: invitationPublicSelect, // never the token (R11)
    orderBy: { createdAt: "desc" },
  });
}

export async function revokeInvitation(ctx: Ctx, projectId: string, invitationId: string) {
  await requirePermission(ctx, projectId, "project.members");
  return prisma.$transaction(async (tx) => {
    const invitation = await tx.projectInvitation.findFirst({
      where: { id: invitationId, projectId }, // tenant-scoped (R9)
    });
    if (!invitation) throw notFound("Invitation");
    if (invitation.acceptedAt) throw invalidState("Invitation has already been accepted");
    if (invitation.revokedAt) throw invalidState("Invitation has already been revoked");
    const updated = await tx.projectInvitation.update({
      where: { id: invitation.id },
      data: { revokedAt: new Date() },
      select: invitationPublicSelect,
    });
    await audit.record(tx, {
      projectId,
      userId: ctx.userId,
      entityType: "ProjectInvitation",
      entityId: invitation.id,
      action: AuditActions.INVITATION_REVOKED,
      previousValue: { email: invitation.email, roles: invitation.roles },
    });
    return updated;
  });
}

// Accept: session user's email must match; not expired/accepted/revoked; consumed atomically.
// Grants project membership AND ensures ACTIVE org membership (the R10 gate requires both).
export async function acceptInvitation(ctx: Ctx, token: string) {
  return prisma.$transaction(async (tx) => {
    const invitation = await tx.projectInvitation.findUnique({ where: { token } });
    if (!invitation) throw notFound("Invitation");

    const user = await tx.user.findUniqueOrThrow({ where: { id: ctx.userId } });
    if (user.email.toLowerCase() !== invitation.email.toLowerCase()) {
      throw forbidden("This invitation was issued to a different email address");
    }
    if (invitation.revokedAt) throw invalidState("Invitation has been revoked");
    if (invitation.acceptedAt) throw invalidState("Invitation has already been used");
    if (invitation.expiresAt.getTime() < Date.now()) throw invalidState("Invitation has expired");

    // Atomic consume — guards double-accept even under concurrent requests.
    const consumed = await tx.projectInvitation.updateMany({
      where: { id: invitation.id, acceptedAt: null, revokedAt: null },
      data: { acceptedAt: new Date() },
    });
    if (consumed.count === 0) throw invalidState("Invitation is no longer valid");

    const project = await tx.project.findUniqueOrThrow({
      where: { id: invitation.projectId },
      select: { id: true, orgId: true, title: true },
    });

    // Ensure ACTIVE org membership (R10): absent → create MEMBER; REMOVED → reactivate as MEMBER.
    const orgMember = await tx.organizationMember.findUnique({
      where: { orgId_userId: { orgId: project.orgId, userId: ctx.userId } },
    });
    let orgMembershipEnsured = false;
    if (!orgMember) {
      await tx.organizationMember.create({
        data: { orgId: project.orgId, userId: ctx.userId, role: "MEMBER" },
      });
      orgMembershipEnsured = true;
    } else if (orgMember.status !== "ACTIVE") {
      await tx.organizationMember.update({
        where: { id: orgMember.id },
        data: { status: "ACTIVE", role: "MEMBER" },
      });
      orgMembershipEnsured = true;
    }

    // Create / reactivate the project membership with the invitation's roles.
    const existing = await tx.projectMember.findUnique({
      where: { projectId_userId: { projectId: project.id, userId: ctx.userId } },
    });
    const membership =
      existing === null
        ? await tx.projectMember.create({
            data: { projectId: project.id, userId: ctx.userId, roles: invitation.roles },
          })
        : existing.status === "ACTIVE"
          ? existing // already an active member — invitation consumed, roles untouched
          : await tx.projectMember.update({
              where: { id: existing.id },
              data: { status: "ACTIVE", roles: invitation.roles },
            });

    await audit.record(tx, {
      projectId: project.id,
      userId: ctx.userId,
      entityType: "ProjectInvitation",
      entityId: invitation.id,
      action: AuditActions.INVITATION_ACCEPTED,
      newValue: { email: invitation.email, roles: invitation.roles },
      metadata: { orgMembershipEnsured },
    });

    return {
      project: { id: project.id, title: project.title },
      membership,
    };
  });
}
