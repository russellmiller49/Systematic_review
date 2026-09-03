// Projects domain service — project lifecycle, project membership, invitations (R10/R11).
// Follows the exemplar shape in src/server/services/orgs/index.ts:
//   - zod schemas exported for route handlers
//   - ctx first argument; actor identity ONLY from ctx
//   - authorization first, then invariants, then mutation inside prisma.$transaction
//   - audit.record(tx, ...) in the SAME transaction as every mutation
//   - by-id loads tenant-scoped (R9) → notFound on mismatch

import { randomBytes } from "node:crypto";
import { z } from "zod";
import type { OrgRole, Prisma, ProjectRole } from "@prisma/client";
import { prisma, type Tx } from "@/server/db";
import { conflict, forbidden, invalidState, notFound } from "@/server/errors";
import type { Ctx } from "@/server/auth/session";
import { getOrgMembership, requirePermission } from "@/server/permissions";
import { capabilitiesFor } from "@/server/permissions/matrix";
import * as audit from "@/server/services/audit";
import { AuditActions } from "@/server/services/audit";
import { getAiConfig } from "@/server/ai/config";
import { resetManuscriptToPicoDefaultsInTransaction } from "@/server/services/manuscript";
import { hasPicoDefaultSectionStructure } from "@/server/services/manuscript/default-sections";

const INVITATION_TTL_MS = 14 * 24 * 60 * 60 * 1000; // 14 days

export const DEFAULT_SCREENING_EXCLUSION_REASONS = [
  "Wrong population",
  "Wrong intervention",
  "Wrong publication type",
  "Wrong outcomes",
] as const;

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
  // Guideline hub: holds the shared reference library + general manuscript sections;
  // PICO questions are added afterwards as sub-projects via createSubProject.
  isGuideline: z.boolean().default(false),
});

// PICO sub-project creation. reviewType is inherited from the guideline; screening
// settings default to the parent's title/abstract stage configuration.
export const createSubProjectSchema = z.object({
  title: z.string().trim().min(2).max(300),
  researchQuestion: z.string().trim().min(5).max(2000), // the PICO question itself
  description: z.string().trim().max(5000).optional(),
  dualScreening: z.boolean().optional(),
  reviewersPerCitation: z.number().int().min(1).max(3).optional(),
  blindedScreening: z.boolean().optional(),
});

export const convertSubProjectSchema = z
  .object({
    sourceProjectId: z.string().trim().min(1),
    resetManuscriptToPicoDefaults: z.boolean().optional().default(false),
    confirmManuscriptDataLoss: z.literal(true).optional(),
  })
  .superRefine((input, refinement) => {
    if (input.resetManuscriptToPicoDefaults && input.confirmManuscriptDataLoss !== true) {
      refinement.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["confirmManuscriptDataLoss"],
        message: "Confirm manuscript data loss before replacing the sections",
      });
    }
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

const ORG_ROLE_RANK: Record<OrgRole, number> = {
  MEMBER: 0,
  ADMIN: 1,
  OWNER: 2,
};

function strongestOrgRole(roles: readonly OrgRole[]): OrgRole {
  return roles.reduce<OrgRole>(
    (strongest, role) => (ORG_ROLE_RANK[role] > ORG_ROLE_RANK[strongest] ? role : strongest),
    "MEMBER",
  );
}

function mergeProjectRoles(...roleSets: ReadonlyArray<readonly ProjectRole[]>): ProjectRole[] {
  return [...new Set(roleSets.flat())];
}

function sameRoles(a: readonly ProjectRole[], b: readonly ProjectRole[]): boolean {
  return a.length === b.length && a.every((role) => b.includes(role));
}

async function createDefaultScreeningExclusionReasons(
  tx: Tx,
  projectId: string,
  userId: string,
) {
  for (const [order, label] of DEFAULT_SCREENING_EXCLUSION_REASONS.entries()) {
    const reason = await tx.exclusionReason.create({
      data: {
        projectId,
        label,
        stage: "BOTH",
        order,
      },
    });
    await audit.record(tx, {
      projectId,
      userId,
      entityType: "ExclusionReason",
      entityId: reason.id,
      action: AuditActions.EXCLUSION_REASON_CREATED,
      newValue: {
        label: reason.label,
        stage: reason.stage,
        order: reason.order,
        isActive: reason.isActive,
      },
      metadata: { projectDefault: true },
    });
  }
}

type GuidelineInvitationResolution = "accepted" | "revoked";

// Guideline membership is family-wide: existing PICO projects receive the same access,
// while PICO-specific roles already granted to a member are preserved. Matching pending
// PICO invitations are settled in the same transaction so settings never show an active
// member beside a stale invitation.
async function syncGuidelineMemberToSubProjects(
  tx: Tx,
  input: {
    guidelineId: string;
    userId: string;
    email: string;
    roles: readonly ProjectRole[];
    actorUserId: string;
    now: Date;
    invitationResolution: GuidelineInvitationResolution;
    sourceInvitationId?: string;
  },
): Promise<{ projectCount: number; invitationCount: number }> {
  const subProjects = await tx.project.findMany({
    where: { parentProjectId: input.guidelineId },
    select: { id: true },
  });
  if (subProjects.length === 0) return { projectCount: 0, invitationCount: 0 };

  const projectIds = subProjects.map((project) => project.id);
  const pendingInvitations = await tx.projectInvitation.findMany({
    where: {
      projectId: { in: projectIds },
      email: input.email,
      acceptedAt: null,
      revokedAt: null,
      expiresAt: { gt: input.now },
    },
    orderBy: { createdAt: "asc" },
  });
  const invitationsByProject = new Map<string, typeof pendingInvitations>();
  for (const invitation of pendingInvitations) {
    const rows = invitationsByProject.get(invitation.projectId) ?? [];
    rows.push(invitation);
    invitationsByProject.set(invitation.projectId, rows);
  }

  for (const project of subProjects) {
    const inheritedInvitationRoles =
      input.invitationResolution === "accepted"
        ? (invitationsByProject.get(project.id) ?? []).flatMap((row) => row.roles)
        : [];
    const inheritedRoles = mergeProjectRoles(input.roles, inheritedInvitationRoles);
    const existing = await tx.projectMember.findUnique({
      where: { projectId_userId: { projectId: project.id, userId: input.userId } },
    });
    const roles = existing
      ? mergeProjectRoles(existing.roles, inheritedRoles)
      : inheritedRoles;

    if (!existing) {
      const member = await tx.projectMember.create({
        data: { projectId: project.id, userId: input.userId, roles },
      });
      await audit.record(tx, {
        projectId: project.id,
        userId: input.actorUserId,
        entityType: "ProjectMember",
        entityId: member.id,
        action: AuditActions.MEMBER_ADDED,
        newValue: { userId: input.userId, roles },
        metadata: { inheritedFromGuidelineId: input.guidelineId },
      });
    } else if (existing.status !== "ACTIVE") {
      const member = await tx.projectMember.update({
        where: { id: existing.id },
        data: { status: "ACTIVE", roles },
      });
      await audit.record(tx, {
        projectId: project.id,
        userId: input.actorUserId,
        entityType: "ProjectMember",
        entityId: member.id,
        action: AuditActions.MEMBER_ADDED,
        previousValue: { status: existing.status, roles: existing.roles },
        newValue: { status: member.status, roles: member.roles },
        metadata: { inheritedFromGuidelineId: input.guidelineId, reactivated: true },
      });
    } else if (!sameRoles(existing.roles, roles)) {
      const member = await tx.projectMember.update({
        where: { id: existing.id },
        data: { roles },
      });
      await audit.record(tx, {
        projectId: project.id,
        userId: input.actorUserId,
        entityType: "ProjectMember",
        entityId: member.id,
        action: AuditActions.MEMBER_ROLES_CHANGED,
        previousValue: { roles: existing.roles },
        newValue: { roles: member.roles },
        metadata: { inheritedFromGuidelineId: input.guidelineId },
      });
    }
  }

  for (const invitation of pendingInvitations) {
    const accepting = input.invitationResolution === "accepted";
    await tx.projectInvitation.update({
      where: { id: invitation.id },
      data: accepting ? { acceptedAt: input.now } : { revokedAt: input.now },
    });
    await audit.record(tx, {
      projectId: invitation.projectId,
      userId: input.actorUserId,
      entityType: "ProjectInvitation",
      entityId: invitation.id,
      action: accepting ? AuditActions.INVITATION_ACCEPTED : AuditActions.INVITATION_REVOKED,
      previousValue: { email: invitation.email, roles: invitation.roles },
      newValue: accepting ? { acceptedAt: input.now } : { revokedAt: input.now },
      metadata: {
        guidelineId: input.guidelineId,
        ...(input.sourceInvitationId
          ? { satisfiedByGuidelineInvitationId: input.sourceInvitationId }
          : { supersededByGuidelineMembership: true }),
      },
    });
  }

  return {
    projectCount: subProjects.length,
    invitationCount: pendingInvitations.length,
  };
}

// A project invitation also satisfies any still-valid workspace invitation for the
// same email. The strongest invited workspace role wins, without ever demoting an
// existing role.
async function reconcileOrganizationInvitations(
  tx: Tx,
  input: {
    orgId: string;
    userId: string;
    email: string;
    actorUserId: string;
    now: Date;
    sourceProjectInvitationId?: string;
  },
) {
  const invitations = await tx.organizationInvitation.findMany({
    where: {
      orgId: input.orgId,
      email: input.email,
      acceptedAt: null,
      revokedAt: null,
      expiresAt: { gt: input.now },
    },
    orderBy: { createdAt: "asc" },
  });
  const invitedRole = strongestOrgRole(invitations.map((row) => row.role));
  const existing = await tx.organizationMember.findUnique({
    where: { orgId_userId: { orgId: input.orgId, userId: input.userId } },
  });
  const role = strongestOrgRole([existing?.role ?? "MEMBER", invitedRole]);
  const membership =
    existing === null
      ? await tx.organizationMember.create({
          data: { orgId: input.orgId, userId: input.userId, role },
        })
      : existing.status !== "ACTIVE" || existing.role !== role
        ? await tx.organizationMember.update({
            where: { id: existing.id },
            data: { status: "ACTIVE", role },
          })
        : existing;

  if (!existing || existing.status !== "ACTIVE") {
    await audit.record(tx, {
      userId: input.actorUserId,
      entityType: "OrganizationMember",
      entityId: membership.id,
      action: AuditActions.MEMBER_ADDED,
      previousValue: existing
        ? { status: existing.status, role: existing.role }
        : undefined,
      newValue: {
        orgId: input.orgId,
        userId: input.userId,
        status: membership.status,
        role: membership.role,
      },
      metadata: existing ? { reactivated: true } : { createdByProjectInvitation: true },
    });
  } else if (existing.role !== membership.role) {
    await audit.record(tx, {
      userId: input.actorUserId,
      entityType: "OrganizationMember",
      entityId: membership.id,
      action: AuditActions.MEMBER_ROLES_CHANGED,
      previousValue: { role: existing.role },
      newValue: { role: membership.role },
      metadata: { reconciledWithOrganizationInvitation: true },
    });
  }

  for (const invitation of invitations) {
    await tx.organizationInvitation.update({
      where: { id: invitation.id },
      data: { acceptedAt: input.now },
    });
    await audit.record(tx, {
      userId: input.actorUserId,
      entityType: "OrganizationInvitation",
      entityId: invitation.id,
      action: AuditActions.INVITATION_ACCEPTED,
      previousValue: { orgId: input.orgId, email: invitation.email, role: invitation.role },
      newValue: { acceptedAt: input.now },
      metadata: input.sourceProjectInvitationId
        ? { satisfiedByProjectInvitationId: input.sourceProjectInvitationId }
        : { reconciledByGuidelineMemberSync: true },
    });
  }

  return {
    membership,
    membershipChanged:
      existing === null || existing.status !== "ACTIVE" || existing.role !== membership.role,
    invitationsAccepted: invitations.length,
  };
}

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
        isGuideline: input.isGuideline,
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
        isGuideline: project.isGuideline,
        dualScreening: input.dualScreening,
        reviewersPerCitation,
        blindedScreening: input.blindedScreening,
      },
    });
    await createDefaultScreeningExclusionReasons(tx, project.id, ctx.userId);
    return { ...project, screeningStages: [titleAbstract, fullText] };
  });
}

// ---------------------------------------------------------------------------
// Guideline sub-projects (one full review project per PICO question)
// ---------------------------------------------------------------------------

// Creates a PICO sub-project under a guideline. The sub-project is a complete review
// project (own protocol, screening stages, extraction, analysis, manuscript) that shares
// the guideline's reference library. The parent's ACTIVE members are copied in with
// their roles; later additions to the guideline are synchronized to existing PICOs.
export async function createSubProject(
  ctx: Ctx,
  parentProjectId: string,
  rawInput: z.input<typeof createSubProjectSchema>,
) {
  await requirePermission(ctx, parentProjectId, "project.edit");
  const input = createSubProjectSchema.parse(rawInput);

  const parent = await prisma.project.findUnique({
    where: { id: parentProjectId },
    include: {
      screeningStages: { where: { type: "TITLE_ABSTRACT" } },
      members: { where: { status: "ACTIVE" } },
    },
  });
  if (!parent) throw notFound("Project");
  if (!parent.isGuideline) {
    throw invalidState("Only guideline projects can contain PICO sub-projects");
  }
  if (parent.parentProjectId) {
    throw invalidState("A sub-project cannot contain its own sub-projects");
  }

  const parentStage = parent.screeningStages[0];
  const dualScreening = input.dualScreening ?? (parentStage ? parentStage.reviewersPerCitation > 1 : true);
  const reviewersPerCitation = dualScreening
    ? (input.reviewersPerCitation ?? (parentStage && parentStage.reviewersPerCitation > 1 ? parentStage.reviewersPerCitation : 2))
    : 1;
  const blinded = input.blindedScreening ?? parentStage?.blinded ?? true;

  return prisma.$transaction(async (tx) => {
    const project = await tx.project.create({
      data: {
        orgId: parent.orgId,
        title: input.title,
        reviewType: parent.reviewType,
        researchQuestion: input.researchQuestion,
        description: input.description ?? null,
        parentProjectId: parent.id,
        createdById: ctx.userId,
      },
    });
    // Copy the guideline team: every ACTIVE parent member keeps their roles; the
    // creator additionally becomes an OWNER of the sub-project.
    await tx.projectMember.createMany({
      data: parent.members.map((m) => ({
        projectId: project.id,
        userId: m.userId,
        roles:
          m.userId === ctx.userId
            ? [...new Set<ProjectRole>(["OWNER", ...m.roles])]
            : m.roles,
      })),
    });
    const stageConfig = { reviewersPerCitation, blinded, maybeGeneratesConflict: true };
    const titleAbstract = await tx.screeningStage.create({
      data: { projectId: project.id, type: "TITLE_ABSTRACT", ...stageConfig },
    });
    const fullText = await tx.screeningStage.create({
      data: { projectId: project.id, type: "FULL_TEXT", ...stageConfig },
    });
    // The PICO question is the sub-project's review question from day one.
    await tx.protocol.create({
      data: { projectId: project.id, reviewQuestion: input.researchQuestion },
    });
    await audit.record(tx, {
      projectId: project.id,
      userId: ctx.userId,
      entityType: "Project",
      entityId: project.id,
      action: AuditActions.PROJECT_CREATED,
      newValue: {
        orgId: parent.orgId,
        title: project.title,
        reviewType: project.reviewType,
        status: project.status,
        parentProjectId: parent.id,
        dualScreening,
        reviewersPerCitation,
        blindedScreening: blinded,
        copiedMembers: parent.members.length,
      },
    });
    // Also visible in the guideline's own audit trail.
    await audit.record(tx, {
      projectId: parent.id,
      userId: ctx.userId,
      entityType: "Project",
      entityId: project.id,
      action: AuditActions.PROJECT_SUBPROJECT_CREATED,
      newValue: { title: project.title, researchQuestion: input.researchQuestion },
    });
    await createDefaultScreeningExclusionReasons(tx, project.id, ctx.userId);
    return { ...project, screeningStages: [titleAbstract, fullText] };
  });
}

// PICO sub-projects of a guideline, with headline counts for the dashboard panel.
export async function listSubProjects(ctx: Ctx, parentProjectId: string) {
  await requirePermission(ctx, parentProjectId, "project.view");
  return prisma.project.findMany({
    where: { parentProjectId },
    include: {
      _count: {
        select: {
          citations: true,
          studies: true,
          members: { where: { status: "ACTIVE" } },
        },
      },
    },
    orderBy: { createdAt: "asc" },
  });
}

function requireOwnerRole(roles: readonly ProjectRole[], message: string) {
  if (!roles.includes("OWNER")) throw forbidden(message);
}

// Standalone projects the current guideline OWNER may convert. Ownership is checked
// on both sides because attaching a project changes its library scope, navigation, and
// the team that can access it.
export async function listConvertibleProjects(ctx: Ctx, parentProjectId: string) {
  const parentMember = await requirePermission(ctx, parentProjectId, "project.edit");
  requireOwnerRole(
    parentMember.roles,
    "Only a guideline owner can convert an existing project",
  );

  const parent = await prisma.project.findUnique({
    where: { id: parentProjectId },
    select: { id: true, orgId: true, isGuideline: true, parentProjectId: true },
  });
  if (!parent) throw notFound("Project");
  if (!parent.isGuideline || parent.parentProjectId) {
    throw invalidState("Only a top-level guideline can accept existing projects");
  }

  const projects = await prisma.project.findMany({
    where: {
      id: { not: parent.id },
      orgId: parent.orgId,
      isGuideline: false,
      parentProjectId: null,
      members: {
        some: {
          userId: ctx.userId,
          status: "ACTIVE",
          roles: { has: "OWNER" },
        },
      },
    },
    select: {
      id: true,
      title: true,
      reviewType: true,
      researchQuestion: true,
      description: true,
      status: true,
      createdAt: true,
      protocol: { select: { reviewQuestion: true } },
      manuscript: {
        select: {
          id: true,
          sections: {
            select: {
              title: true,
              kind: true,
              order: true,
              wordCount: true,
              _count: { select: { comments: true, versions: true } },
            },
            orderBy: { order: "asc" },
          },
        },
      },
      _count: {
        select: {
          citations: true,
          studies: true,
          referenceEntries: true,
          members: { where: { status: "ACTIVE" } },
        },
      },
    },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
  });
  return projects.map((project) => ({
    ...project,
    manuscript: project.manuscript
      ? {
          ...project.manuscript,
          usesPicoDefaultSections: hasPicoDefaultSectionStructure(
            project.manuscript.sections,
          ),
        }
      : null,
  }));
}

type ReferenceCollisionRow = {
  title: string;
  doi: string | null;
  pmid: string | null;
  citationId: string | null;
};

function describeReferenceCollision(reference: ReferenceCollisionRow) {
  const identifier = reference.doi
    ? `DOI ${reference.doi}`
    : reference.pmid
      ? `PMID ${reference.pmid}`
      : "the same mirrored citation";
  return `“${reference.title}” (${identifier})`;
}

// Converts a previously created standalone review into a PICO sub-project without
// recreating it. All project-owned workflow rows keep their IDs. Reference rows move
// to the family root so existing manuscript citation nodes keep resolving.
export async function convertProjectToSubProject(
  ctx: Ctx,
  parentProjectId: string,
  rawInput: z.input<typeof convertSubProjectSchema>,
) {
  const input = convertSubProjectSchema.parse(rawInput);
  if (input.sourceProjectId === parentProjectId) {
    throw invalidState("A guideline cannot be converted into its own sub-project");
  }

  const parentMember = await requirePermission(ctx, parentProjectId, "project.edit");
  requireOwnerRole(
    parentMember.roles,
    "Only a guideline owner can convert an existing project",
  );
  const sourceMember = await requirePermission(ctx, input.sourceProjectId, "project.edit");
  requireOwnerRole(
    sourceMember.roles,
    "You must be an owner of the project being converted",
  );

  return prisma.$transaction(async (tx) => {
    // Re-check both memberships inside the mutation transaction so an ownership change
    // cannot race the conversion.
    const currentParentMember = await requirePermission(
      ctx,
      parentProjectId,
      "project.edit",
      tx,
    );
    requireOwnerRole(
      currentParentMember.roles,
      "Only a guideline owner can convert an existing project",
    );
    const currentSourceMember = await requirePermission(
      ctx,
      input.sourceProjectId,
      "project.edit",
      tx,
    );
    requireOwnerRole(
      currentSourceMember.roles,
      "You must be an owner of the project being converted",
    );

    const parent = await tx.project.findUnique({
      where: { id: parentProjectId },
      include: { members: { where: { status: "ACTIVE" } } },
    });
    if (!parent) throw notFound("Project");
    if (!parent.isGuideline || parent.parentProjectId) {
      throw invalidState("Only a top-level guideline can accept existing projects");
    }

    const source = await tx.project.findUnique({
      where: { id: input.sourceProjectId },
      include: {
        protocol: { select: { reviewQuestion: true } },
        members: { select: { userId: true } },
        _count: { select: { subProjects: true } },
      },
    });
    if (!source) throw notFound("Project");
    if (source.orgId !== parent.orgId) {
      throw invalidState("The project and guideline must belong to the same organization");
    }
    if (source.isGuideline || source._count.subProjects > 0) {
      throw invalidState("A guideline project cannot be converted into a PICO sub-project");
    }
    if (source.parentProjectId) {
      throw invalidState("This project is already part of a guideline");
    }
    const resolvedResearchQuestion =
      source.researchQuestion?.trim() ||
      source.protocol?.reviewQuestion?.trim() ||
      null;

    // Claim the standalone project before inspecting/moving dependent rows. A concurrent
    // conversion waits on this update and then fails the standalone predicate.
    const claimed = await tx.project.updateMany({
      where: {
        id: source.id,
        orgId: parent.orgId,
        isGuideline: false,
        parentProjectId: null,
      },
      data: {
        parentProjectId: parent.id,
        // A project-level research question is the compiled guideline subtitle. Older
        // projects may have stored it only in Protocol.reviewQuestion.
        researchQuestion: resolvedResearchQuestion,
      },
    });
    if (claimed.count !== 1) {
      throw invalidState("This project is no longer available for conversion");
    }

    const sourceReferences = await tx.referenceEntry.findMany({
      where: { projectId: source.id },
      select: { id: true, title: true, doi: true, pmid: true, citationId: true },
    });
    const dois = sourceReferences
      .map((reference) => reference.doi)
      .filter((doi): doi is string => doi !== null);
    const pmids = sourceReferences
      .map((reference) => reference.pmid)
      .filter((pmid): pmid is string => pmid !== null);
    const citationIds = sourceReferences
      .map((reference) => reference.citationId)
      .filter((citationId): citationId is string => citationId !== null);
    const collisionFilters: Prisma.ReferenceEntryWhereInput[] = [];
    if (dois.length > 0) collisionFilters.push({ doi: { in: dois } });
    if (pmids.length > 0) collisionFilters.push({ pmid: { in: pmids } });
    if (citationIds.length > 0) {
      collisionFilters.push({ citationId: { in: citationIds } });
    }

    const collisions =
      collisionFilters.length === 0
        ? []
        : await tx.referenceEntry.findMany({
            where: { projectId: parent.id, OR: collisionFilters },
            select: { title: true, doi: true, pmid: true, citationId: true },
          });
    if (collisions.length > 0) {
      const examples = collisions
        .slice(0, 3)
        .map(describeReferenceCollision)
        .join(", ");
      const remaining = collisions.length > 3 ? ` and ${collisions.length - 3} more` : "";
      throw conflict(
        `Resolve ${collisions.length} duplicate reference${collisions.length === 1 ? "" : "s"} before converting: ${examples}${remaining}`,
      );
    }

    const movedReferences = await tx.referenceEntry.updateMany({
      where: { projectId: source.id },
      data: { projectId: parent.id },
    });

    // Preserve the existing project's team and access decisions. Add only guideline
    // members who have never had a membership row in the source; a previously removed
    // source member is deliberately not reactivated.
    const existingMemberIds = new Set(source.members.map((member) => member.userId));
    const membersToAdd = parent.members.filter(
      (member) => !existingMemberIds.has(member.userId),
    );
    if (membersToAdd.length > 0) {
      await tx.projectMember.createMany({
        data: membersToAdd.map((member) => ({
          projectId: source.id,
          userId: member.userId,
          roles: member.roles,
        })),
        skipDuplicates: true,
      });
    }

    // Keep the project-level and protocol-level question fields aligned when an older
    // project populated only one of them.
    if (!source.protocol?.reviewQuestion && resolvedResearchQuestion) {
      await tx.protocol.updateMany({
        where: { projectId: source.id },
        data: { reviewQuestion: resolvedResearchQuestion },
      });
    }

    const manuscriptReset =
      input.resetManuscriptToPicoDefaults && input.confirmManuscriptDataLoss === true
      ? await resetManuscriptToPicoDefaultsInTransaction(ctx, source.id, tx, {
          confirmDataLoss: input.confirmManuscriptDataLoss,
          trigger: "PROJECT_CONVERSION",
        })
      : null;

    const conversionMetadata = {
      guidelineProjectId: parent.id,
      movedReferences: movedReferences.count,
      addedGuidelineMembers: membersToAdd.length,
      preservedExistingMembers: source.members.length,
      manuscriptResetToPicoDefaults: manuscriptReset !== null,
      ...(manuscriptReset
        ? {
            deletedManuscriptSections: manuscriptReset.deletedSectionCount,
            deletedManuscriptComments: manuscriptReset.deletedCommentCount,
            deletedManuscriptVersions: manuscriptReset.deletedVersionCount,
          }
        : {}),
    };
    await audit.record(tx, {
      projectId: source.id,
      userId: ctx.userId,
      entityType: "Project",
      entityId: source.id,
      action: AuditActions.PROJECT_SUBPROJECT_CONVERTED,
      previousValue: {
        parentProjectId: null,
        researchQuestion: source.researchQuestion,
      },
      newValue: {
        parentProjectId: parent.id,
        researchQuestion: resolvedResearchQuestion,
      },
      metadata: conversionMetadata,
    });
    await audit.record(tx, {
      projectId: parent.id,
      userId: ctx.userId,
      entityType: "Project",
      entityId: source.id,
      action: AuditActions.PROJECT_SUBPROJECT_CONVERTED,
      newValue: {
        title: source.title,
        researchQuestion: resolvedResearchQuestion,
      },
      metadata: conversionMetadata,
    });

    return tx.project.findUniqueOrThrow({
      where: { id: source.id },
      include: {
        _count: {
          select: {
            citations: true,
            studies: true,
            members: { where: { status: "ACTIVE" } },
          },
        },
      },
    });
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
      parentProject: { select: { id: true, title: true } },
      screeningPoolMembership: {
        select: {
          pool: { select: { id: true, name: true, guidelineId: true } },
        },
      },
      subProjects: {
        select: { id: true, title: true, status: true, researchQuestion: true },
        orderBy: { createdAt: "asc" },
      },
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
    capabilities: capabilitiesFor(member.roles),
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

// Active workspace members who do not currently have ACTIVE access to this project.
// This powers the project-settings picker, keeping workspace and project roles explicit
// while avoiding error-prone email re-entry. Removed project members are included so an
// Owner/Admin can reactivate them through the normal audited addProjectMember path.
export async function listAssignableWorkspaceMembers(ctx: Ctx, projectId: string) {
  await requirePermission(ctx, projectId, "project.members");
  const project = await prisma.project.findUnique({
    where: { id: projectId },
    select: { orgId: true },
  });
  if (!project) throw notFound("Project");

  return prisma.organizationMember.findMany({
    where: {
      orgId: project.orgId,
      status: "ACTIVE",
      user: {
        projectMemberships: {
          none: { projectId, status: "ACTIVE" },
        },
      },
    },
    select: {
      id: true,
      role: true,
      user: { select: { id: true, name: true, email: true } },
    },
    orderBy: [{ user: { name: "asc" } }, { createdAt: "asc" }],
  });
}

// Idempotent repair path for guideline members created before family-wide synchronization
// existed. It is intentionally service-only: callers must already manage the guideline.
export async function synchronizeGuidelineMemberAccess(
  ctx: Ctx,
  guidelineId: string,
  targetUserId: string,
) {
  await requirePermission(ctx, guidelineId, "project.members");
  return prisma.$transaction(async (tx) => {
    const guideline = await tx.project.findUnique({
      where: { id: guidelineId },
      select: { id: true, orgId: true, isGuideline: true },
    });
    if (!guideline) throw notFound("Project");
    if (!guideline.isGuideline) {
      throw invalidState("Only guideline projects have family-wide member access");
    }
    const member = await tx.projectMember.findFirst({
      where: { projectId: guidelineId, userId: targetUserId, status: "ACTIVE" },
    });
    if (!member) throw notFound("Active guideline member");
    const user = await tx.user.findUniqueOrThrow({
      where: { id: targetUserId },
      select: { email: true },
    });
    const acceptedGuidelineInvitation = await tx.projectInvitation.findFirst({
      where: {
        projectId: guidelineId,
        email: user.email.toLowerCase(),
        acceptedAt: { not: null },
      },
      orderBy: { acceptedAt: "desc" },
      select: { id: true },
    });
    const now = new Date();
    const organizationResult = acceptedGuidelineInvitation
      ? await reconcileOrganizationInvitations(tx, {
          orgId: guideline.orgId,
          userId: targetUserId,
          email: user.email.toLowerCase(),
          actorUserId: ctx.userId,
          now,
          sourceProjectInvitationId: acceptedGuidelineInvitation.id,
        })
      : null;
    const familyResult = await syncGuidelineMemberToSubProjects(tx, {
      guidelineId,
      userId: targetUserId,
      email: user.email.toLowerCase(),
      roles: member.roles,
      actorUserId: ctx.userId,
      now,
      invitationResolution: acceptedGuidelineInvitation ? "accepted" : "revoked",
      sourceInvitationId: acceptedGuidelineInvitation?.id,
    });
    return {
      member,
      subProjectMembershipsSynchronized: familyResult.projectCount,
      projectInvitationsSettled: familyResult.invitationCount,
      organizationInvitationsSettled: organizationResult?.invitationsAccepted ?? 0,
    };
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
      select: { id: true, orgId: true, isGuideline: true },
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
    if (project.isGuideline) {
      await syncGuidelineMemberToSubProjects(tx, {
        guidelineId: project.id,
        userId: user.id,
        email,
        roles: member.roles,
        actorUserId: ctx.userId,
        now: new Date(),
        invitationResolution: "revoked",
      });
    }
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
    const now = new Date();
    const consumed = await tx.projectInvitation.updateMany({
      where: { id: invitation.id, acceptedAt: null, revokedAt: null },
      data: { acceptedAt: now },
    });
    if (consumed.count === 0) throw invalidState("Invitation is no longer valid");

    const project = await tx.project.findUniqueOrThrow({
      where: { id: invitation.projectId },
      select: { id: true, orgId: true, title: true, isGuideline: true },
    });

    // Ensure ACTIVE org membership (R10) and settle a matching workspace invitation,
    // applying its role so an accepted ADMIN invite cannot remain a MEMBER row.
    const orgResult = await reconcileOrganizationInvitations(tx, {
      orgId: project.orgId,
      userId: ctx.userId,
      email: invitation.email,
      actorUserId: ctx.userId,
      now,
      sourceProjectInvitationId: invitation.id,
    });

    // Create / reactivate the project membership and merge roles when the user already
    // has access; accepting an invitation must never silently discard its role grant.
    const existing = await tx.projectMember.findUnique({
      where: { projectId_userId: { projectId: project.id, userId: ctx.userId } },
    });
    const roles =
      existing?.status === "ACTIVE"
        ? mergeProjectRoles(existing.roles, invitation.roles)
        : invitation.roles;
    const membership =
      existing === null
        ? await tx.projectMember.create({
            data: { projectId: project.id, userId: ctx.userId, roles },
          })
        : existing.status === "ACTIVE" && sameRoles(existing.roles, roles)
          ? existing
          : await tx.projectMember.update({
              where: { id: existing.id },
              data: { status: "ACTIVE", roles },
            });

    const familyResult = project.isGuideline
      ? await syncGuidelineMemberToSubProjects(tx, {
          guidelineId: project.id,
          userId: ctx.userId,
          email: invitation.email,
          roles: membership.roles,
          actorUserId: ctx.userId,
          now,
          invitationResolution: "accepted",
          sourceInvitationId: invitation.id,
        })
      : { projectCount: 0, invitationCount: 0 };

    await audit.record(tx, {
      projectId: project.id,
      userId: ctx.userId,
      entityType: "ProjectInvitation",
      entityId: invitation.id,
      action: AuditActions.INVITATION_ACCEPTED,
      newValue: { email: invitation.email, roles: invitation.roles },
      metadata: {
        orgMembershipEnsured: orgResult.membershipChanged,
        organizationInvitationsAccepted: orgResult.invitationsAccepted,
        subProjectMembershipsSynchronized: familyResult.projectCount,
        subProjectInvitationsAccepted: familyResult.invitationCount,
      },
    });

    return {
      project: { id: project.id, title: project.title },
      membership,
    };
  });
}
