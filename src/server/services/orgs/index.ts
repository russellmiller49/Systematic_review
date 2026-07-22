// EXEMPLAR SERVICE — every domain service follows this shape:
//   - zod schemas for inputs, exported for the route handler
//   - ctx first argument; actor identity ONLY from ctx
//   - authorization first, then invariants, then mutation inside prisma.$transaction
//   - audit.record(tx, ...) in the SAME transaction as every mutation
//   - by-id loads scoped to the tenant (R9 in docs/09) → notFound on mismatch

import { randomBytes } from "node:crypto";
import { z } from "zod";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/server/db";
import { conflict, forbidden, notFound, invalidState } from "@/server/errors";
import type { Ctx } from "@/server/auth/session";
import { getOrgMembership, requireOrgRole } from "@/server/permissions";
import * as audit from "@/server/services/audit";
import { AuditActions } from "@/server/services/audit";

const ORGANIZATION_INVITATION_TTL_MS = 14 * 24 * 60 * 60 * 1000;
const orgRoleEnum = z.enum(["OWNER", "ADMIN", "MEMBER"]);

export const createOrgSchema = z.object({
  name: z.string().trim().min(2).max(120),
});

export const updateOrgSchema = z.object({
  name: z.string().trim().min(2).max(120).optional(),
});

export const addOrgMemberSchema = z.object({
  email: z.string().email(),
  role: orgRoleEnum,
});

export const updateOrgMemberSchema = z.object({
  role: orgRoleEnum,
});

export const createOrganizationInvitationSchema = z.object({
  email: z.string().email(),
  role: orgRoleEnum,
});

const httpsUrl = z
  .string()
  .trim()
  .url()
  .max(500)
  .refine((u) => u.startsWith("https://"), "Must be an https:// URL");

export const updateLibrarySettingsSchema = z.object({
  institutionName: z.string().trim().min(2).max(200).nullable().optional(),
  ezproxyBaseUrl: httpsUrl.nullable().optional(),
  openUrlBaseUrl: httpsUrl.nullable().optional(),
});

// Everything except `token`: the secret is returned only by createOrganizationInvitation.
const organizationInvitationPublicSelect = {
  id: true,
  orgId: true,
  email: true,
  role: true,
  invitedById: true,
  expiresAt: true,
  acceptedAt: true,
  revokedAt: true,
  createdAt: true,
  invitedBy: { select: { id: true, name: true, email: true } },
} satisfies Prisma.OrganizationInvitationSelect;

function slugify(name: string): string {
  const base = name
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 50);
  return base || "org";
}

export async function createOrg(ctx: Ctx, input: z.infer<typeof createOrgSchema>) {
  return prisma.$transaction(async (tx) => {
    let slug = slugify(input.name);
    if (await tx.organization.findUnique({ where: { slug } })) {
      slug = `${slug}-${Math.random().toString(36).slice(2, 8)}`;
    }
    const org = await tx.organization.create({
      data: { name: input.name, slug, createdById: ctx.userId },
    });
    await tx.organizationMember.create({
      data: { orgId: org.id, userId: ctx.userId, role: "OWNER" },
    });
    await audit.record(tx, {
      userId: ctx.userId,
      entityType: "Organization",
      entityId: org.id,
      action: AuditActions.ORG_CREATED,
      newValue: { name: org.name, slug: org.slug },
    });
    return org;
  });
}

export async function listMyOrgs(ctx: Ctx) {
  const memberships = await prisma.organizationMember.findMany({
    where: { userId: ctx.userId, status: "ACTIVE" },
    include: {
      org: { include: { _count: { select: { projects: true, members: true } } } },
    },
    orderBy: { createdAt: "asc" },
  });
  return memberships.map((m) => ({ role: m.role, ...m.org }));
}

export async function getOrg(ctx: Ctx, orgId: string) {
  const membership = await getOrgMembership(ctx.userId, orgId);
  if (!membership) throw notFound("Organization");
  const org = await prisma.organization.findUniqueOrThrow({ where: { id: orgId } });
  return { ...org, myRole: membership.role };
}

export async function updateOrg(ctx: Ctx, orgId: string, input: z.infer<typeof updateOrgSchema>) {
  await requireOrgRole(ctx, orgId, ["OWNER", "ADMIN"]);
  return prisma.$transaction(async (tx) => {
    const before = await tx.organization.findUniqueOrThrow({ where: { id: orgId } });
    const org = await tx.organization.update({ where: { id: orgId }, data: input });
    await audit.record(tx, {
      userId: ctx.userId,
      entityType: "Organization",
      entityId: orgId,
      action: AuditActions.ORG_UPDATED,
      previousValue: { name: before.name },
      newValue: { name: org.name },
    });
    return org;
  });
}

// Any ACTIVE org member may read the settings (they power everyone's library links);
// only OWNER/ADMIN may change them. Returns null fields when nothing is configured.
export async function getLibrarySettings(ctx: Ctx, orgId: string) {
  const membership = await getOrgMembership(ctx.userId, orgId);
  if (!membership) throw notFound("Organization");
  const settings = await prisma.organizationLibrarySettings.findUnique({ where: { orgId } });
  return {
    institutionName: settings?.institutionName ?? null,
    ezproxyBaseUrl: settings?.ezproxyBaseUrl ?? null,
    openUrlBaseUrl: settings?.openUrlBaseUrl ?? null,
    updatedAt: settings?.updatedAt ?? null,
  };
}

export async function updateLibrarySettings(
  ctx: Ctx,
  orgId: string,
  input: z.infer<typeof updateLibrarySettingsSchema>,
) {
  await requireOrgRole(ctx, orgId, ["OWNER", "ADMIN"]);
  return prisma.$transaction(async (tx) => {
    const before = await tx.organizationLibrarySettings.findUnique({ where: { orgId } });
    const data = {
      institutionName: input.institutionName !== undefined ? input.institutionName : undefined,
      ezproxyBaseUrl: input.ezproxyBaseUrl !== undefined ? input.ezproxyBaseUrl : undefined,
      openUrlBaseUrl: input.openUrlBaseUrl !== undefined ? input.openUrlBaseUrl : undefined,
      updatedById: ctx.userId,
    };
    const settings = await tx.organizationLibrarySettings.upsert({
      where: { orgId },
      create: {
        orgId,
        institutionName: input.institutionName ?? null,
        ezproxyBaseUrl: input.ezproxyBaseUrl ?? null,
        openUrlBaseUrl: input.openUrlBaseUrl ?? null,
        updatedById: ctx.userId,
      },
      update: data,
    });
    await audit.record(tx, {
      userId: ctx.userId,
      entityType: "OrganizationLibrarySettings",
      entityId: settings.id,
      action: AuditActions.ORG_LIBRARY_SETTINGS_UPDATED,
      previousValue: before
        ? {
            institutionName: before.institutionName,
            ezproxyBaseUrl: before.ezproxyBaseUrl,
            openUrlBaseUrl: before.openUrlBaseUrl,
          }
        : undefined,
      newValue: {
        institutionName: settings.institutionName,
        ezproxyBaseUrl: settings.ezproxyBaseUrl,
        openUrlBaseUrl: settings.openUrlBaseUrl,
      },
      metadata: { orgId },
    });
    return {
      institutionName: settings.institutionName,
      ezproxyBaseUrl: settings.ezproxyBaseUrl,
      openUrlBaseUrl: settings.openUrlBaseUrl,
      updatedAt: settings.updatedAt,
    };
  });
}

export async function listOrgMembers(ctx: Ctx, orgId: string) {
  const membership = await getOrgMembership(ctx.userId, orgId);
  if (!membership) throw notFound("Organization");
  return prisma.organizationMember.findMany({
    where: { orgId },
    include: { user: { select: { id: true, name: true, email: true } } },
    orderBy: { createdAt: "asc" },
  });
}

export async function addOrgMember(
  ctx: Ctx,
  orgId: string,
  input: z.infer<typeof addOrgMemberSchema>,
) {
  await requireOrgRole(ctx, orgId, ["OWNER", "ADMIN"]);
  const email = input.email.toLowerCase().trim();
  return prisma.$transaction(async (tx) => {
    const user = await tx.user.findUnique({ where: { email } });
    if (!user) throw notFound("User with this email");
    const existing = await tx.organizationMember.findUnique({
      where: { orgId_userId: { orgId, userId: user.id } },
    });
    if (existing?.status === "ACTIVE") throw conflict("Already a member of this organization");
    const member = existing
      ? await tx.organizationMember.update({
          where: { id: existing.id },
          data: { status: "ACTIVE", role: input.role },
        })
      : await tx.organizationMember.create({
          data: { orgId, userId: user.id, role: input.role },
        });
    await audit.record(tx, {
      userId: ctx.userId,
      entityType: "OrganizationMember",
      entityId: member.id,
      action: AuditActions.MEMBER_ADDED,
      newValue: { orgId, userId: user.id, role: member.role },
    });
    return member;
  });
}

export async function updateOrgMemberRole(
  ctx: Ctx,
  orgId: string,
  targetUserId: string,
  input: z.infer<typeof updateOrgMemberSchema>,
) {
  await requireOrgRole(ctx, orgId, ["OWNER", "ADMIN"]);
  return prisma.$transaction(async (tx) => {
    const member = await tx.organizationMember.findFirst({
      where: { orgId, userId: targetUserId, status: "ACTIVE" },
    });
    if (!member) throw notFound("Member");
    if (member.role === "OWNER") {
      const owners = await tx.organizationMember.count({
        where: { orgId, role: "OWNER", status: "ACTIVE" },
      });
      if (owners <= 1 && input.role !== "OWNER") {
        throw invalidState("An organization must keep at least one owner");
      }
    }
    const updated = await tx.organizationMember.update({
      where: { id: member.id },
      data: { role: input.role },
    });
    await audit.record(tx, {
      userId: ctx.userId,
      entityType: "OrganizationMember",
      entityId: member.id,
      action: AuditActions.MEMBER_ROLES_CHANGED,
      previousValue: { role: member.role },
      newValue: { role: updated.role },
    });
    return updated;
  });
}

// Soft removal — the user's historical work stays attributed everywhere.
export async function removeOrgMember(ctx: Ctx, orgId: string, targetUserId: string) {
  await requireOrgRole(ctx, orgId, ["OWNER", "ADMIN"]);
  return prisma.$transaction(async (tx) => {
    const member = await tx.organizationMember.findFirst({
      where: { orgId, userId: targetUserId, status: "ACTIVE" },
    });
    if (!member) throw notFound("Member");
    if (member.role === "OWNER") {
      const owners = await tx.organizationMember.count({
        where: { orgId, role: "OWNER", status: "ACTIVE" },
      });
      if (owners <= 1) throw invalidState("An organization must keep at least one owner");
    }
    const updated = await tx.organizationMember.update({
      where: { id: member.id },
      data: { status: "REMOVED" },
    });
    await audit.record(tx, {
      userId: ctx.userId,
      entityType: "OrganizationMember",
      entityId: member.id,
      action: AuditActions.MEMBER_REMOVED,
      previousValue: { role: member.role, status: "ACTIVE" },
      newValue: { status: "REMOVED" },
    });
    return updated;
  });
}

// ---------------------------------------------------------------------------
// Organization invitations
// ---------------------------------------------------------------------------

export async function createOrganizationInvitation(
  ctx: Ctx,
  orgId: string,
  input: z.infer<typeof createOrganizationInvitationSchema>,
) {
  await requireOrgRole(ctx, orgId, ["OWNER", "ADMIN"]);
  const email = input.email.toLowerCase().trim();
  const token = randomBytes(32).toString("base64url");
  const expiresAt = new Date(Date.now() + ORGANIZATION_INVITATION_TTL_MS);

  return prisma.$transaction(async (tx) => {
    const existingUser = await tx.user.findUnique({
      where: { email },
      select: { id: true },
    });
    if (existingUser) {
      const existingMember = await tx.organizationMember.findUnique({
        where: { orgId_userId: { orgId, userId: existingUser.id } },
      });
      if (existingMember?.status === "ACTIVE") {
        throw conflict("This person is already a member of the organization");
      }
    }

    const invitation = await tx.organizationInvitation.create({
      data: {
        orgId,
        email,
        role: input.role,
        token,
        invitedById: ctx.userId,
        expiresAt,
      },
    });
    await audit.record(tx, {
      userId: ctx.userId,
      entityType: "OrganizationInvitation",
      entityId: invitation.id,
      action: AuditActions.INVITATION_CREATED,
      newValue: { orgId, email, role: input.role, expiresAt },
    });
    return invitation;
  });
}

export async function listOrganizationInvitations(ctx: Ctx, orgId: string) {
  await requireOrgRole(ctx, orgId, ["OWNER", "ADMIN"]);
  return prisma.organizationInvitation.findMany({
    where: { orgId },
    select: organizationInvitationPublicSelect,
    orderBy: { createdAt: "desc" },
  });
}

export async function revokeOrganizationInvitation(
  ctx: Ctx,
  orgId: string,
  invitationId: string,
) {
  await requireOrgRole(ctx, orgId, ["OWNER", "ADMIN"]);
  return prisma.$transaction(async (tx) => {
    const invitation = await tx.organizationInvitation.findFirst({
      where: { id: invitationId, orgId },
    });
    if (!invitation) throw notFound("Invitation");
    if (invitation.acceptedAt) throw invalidState("Invitation has already been accepted");
    if (invitation.revokedAt) throw invalidState("Invitation has already been revoked");

    const updated = await tx.organizationInvitation.update({
      where: { id: invitation.id },
      data: { revokedAt: new Date() },
      select: organizationInvitationPublicSelect,
    });
    await audit.record(tx, {
      userId: ctx.userId,
      entityType: "OrganizationInvitation",
      entityId: invitation.id,
      action: AuditActions.INVITATION_REVOKED,
      previousValue: { orgId, email: invitation.email, role: invitation.role },
    });
    return updated;
  });
}

export async function acceptOrganizationInvitation(ctx: Ctx, token: string) {
  return prisma.$transaction(async (tx) => {
    const invitation = await tx.organizationInvitation.findUnique({
      where: { token },
      include: { organization: { select: { id: true, name: true, slug: true } } },
    });
    if (!invitation) throw notFound("Invitation");

    const user = await tx.user.findUniqueOrThrow({ where: { id: ctx.userId } });
    if (user.email.toLowerCase() !== invitation.email.toLowerCase()) {
      throw forbidden("This invitation was issued to a different email address");
    }
    if (invitation.revokedAt) throw invalidState("Invitation has been revoked");
    if (invitation.acceptedAt) throw invalidState("Invitation has already been used");

    const now = new Date();
    if (invitation.expiresAt.getTime() < now.getTime()) {
      throw invalidState("Invitation has expired");
    }

    // Consume and validate expiry atomically so concurrent accepts cannot both succeed.
    const consumed = await tx.organizationInvitation.updateMany({
      where: {
        id: invitation.id,
        acceptedAt: null,
        revokedAt: null,
        expiresAt: { gt: now },
      },
      data: { acceptedAt: now },
    });
    if (consumed.count === 0) throw invalidState("Invitation is no longer valid");

    const existing = await tx.organizationMember.findUnique({
      where: { orgId_userId: { orgId: invitation.orgId, userId: ctx.userId } },
    });
    const membership =
      existing === null
        ? await tx.organizationMember.create({
            data: { orgId: invitation.orgId, userId: ctx.userId, role: invitation.role },
          })
        : existing.status === "ACTIVE"
          ? existing
          : await tx.organizationMember.update({
              where: { id: existing.id },
              data: { status: "ACTIVE", role: invitation.role },
            });

    await audit.record(tx, {
      userId: ctx.userId,
      entityType: "OrganizationInvitation",
      entityId: invitation.id,
      action: AuditActions.INVITATION_ACCEPTED,
      newValue: {
        orgId: invitation.orgId,
        email: invitation.email,
        role: invitation.role,
      },
      metadata: { membershipReactivated: existing?.status === "REMOVED" },
    });

    return { organization: invitation.organization, membership };
  });
}
