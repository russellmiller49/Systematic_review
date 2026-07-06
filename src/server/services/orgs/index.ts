// EXEMPLAR SERVICE — every domain service follows this shape:
//   - zod schemas for inputs, exported for the route handler
//   - ctx first argument; actor identity ONLY from ctx
//   - authorization first, then invariants, then mutation inside prisma.$transaction
//   - audit.record(tx, ...) in the SAME transaction as every mutation
//   - by-id loads scoped to the tenant (R9 in docs/09) → notFound on mismatch

import { z } from "zod";
import { prisma } from "@/server/db";
import { conflict, notFound, invalidState } from "@/server/errors";
import type { Ctx } from "@/server/auth/session";
import { getOrgMembership, requireOrgRole } from "@/server/permissions";
import * as audit from "@/server/services/audit";
import { AuditActions } from "@/server/services/audit";

export const createOrgSchema = z.object({
  name: z.string().trim().min(2).max(120),
});

export const updateOrgSchema = z.object({
  name: z.string().trim().min(2).max(120).optional(),
});

export const addOrgMemberSchema = z.object({
  email: z.string().email(),
  role: z.enum(["OWNER", "ADMIN", "MEMBER"]),
});

export const updateOrgMemberSchema = z.object({
  role: z.enum(["OWNER", "ADMIN", "MEMBER"]),
});

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
