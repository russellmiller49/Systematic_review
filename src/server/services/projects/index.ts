// Projects domain service — project lifecycle, project membership, invitations (R10/R11).
// Follows the exemplar shape in src/server/services/orgs/index.ts:
//   - zod schemas exported for route handlers
//   - ctx first argument; actor identity ONLY from ctx
//   - authorization first, then invariants, then mutation inside prisma.$transaction
//   - audit.record(tx, ...) in the SAME transaction as every mutation
//   - by-id loads tenant-scoped (R9) → notFound on mismatch

import { randomBytes } from "node:crypto";
import { z } from "zod";
import type { Prisma, ProjectRole } from "@prisma/client";
import { prisma } from "@/server/db";
import { conflict, forbidden, invalidState, notFound } from "@/server/errors";
import type { Ctx } from "@/server/auth/session";
import { getOrgMembership, requirePermission } from "@/server/permissions";
import { capabilitiesFor } from "@/server/permissions/matrix";
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

export const convertSubProjectSchema = z.object({
  sourceProjectId: z.string().trim().min(1),
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
    return { ...project, screeningStages: [titleAbstract, fullText] };
  });
}

// ---------------------------------------------------------------------------
// Guideline sub-projects (one full review project per PICO question)
// ---------------------------------------------------------------------------

// Creates a PICO sub-project under a guideline. The sub-project is a complete review
// project (own protocol, screening stages, extraction, analysis, manuscript) that shares
// the guideline's reference library. The parent's ACTIVE members are copied in with
// their roles so the team keeps working without re-inviting; membership is managed
// independently per project afterwards.
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

  return prisma.project.findMany({
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

    const conversionMetadata = {
      guidelineProjectId: parent.id,
      movedReferences: movedReferences.count,
      addedGuidelineMembers: membersToAdd.length,
      preservedExistingMembers: source.members.length,
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
