import type { OrganizationMember, OrgRole, ProjectMember } from "@prisma/client";
import { prisma, type Tx } from "@/server/db";
import { forbidden } from "@/server/errors";
import type { Ctx } from "@/server/auth/session";
import { can, type Capability } from "./matrix";

export { can, capabilitiesFor, CAPABILITIES, type Capability } from "./matrix";

// Org-level authorization (project-level uses the capability matrix below).
export async function getOrgMembership(
  userId: string,
  orgId: string,
  tx: Tx = prisma,
): Promise<OrganizationMember | null> {
  const member = await tx.organizationMember.findUnique({
    where: { orgId_userId: { orgId, userId } },
  });
  return member && member.status === "ACTIVE" ? member : null;
}

export async function requireOrgRole(
  ctx: Ctx,
  orgId: string,
  roles: readonly OrgRole[],
  tx: Tx = prisma,
): Promise<OrganizationMember> {
  const member = await getOrgMembership(ctx.userId, orgId, tx);
  if (!member || !roles.includes(member.role)) throw forbidden();
  return member;
}

// ACTIVE membership or null. REMOVED members keep their historical work but lose all access.
// R10 (docs/09): project access ALSO requires an ACTIVE org membership in the project's org —
// removing someone from the organization instantly cuts project access.
export async function getMembership(
  userId: string,
  projectId: string,
  tx: Tx = prisma,
): Promise<ProjectMember | null> {
  const member = await tx.projectMember.findUnique({
    where: { projectId_userId: { projectId, userId } },
    include: { project: { select: { orgId: true } } },
  });
  if (!member || member.status !== "ACTIVE") return null;
  const orgMember = await tx.organizationMember.findUnique({
    where: { orgId_userId: { orgId: member.project.orgId, userId } },
  });
  if (!orgMember || orgMember.status !== "ACTIVE") return null;
  return member;
}

// Every service mutation (and protected read) starts here. Throws 403.
export async function requirePermission(
  ctx: Ctx,
  projectId: string,
  capability: Capability,
  tx: Tx = prisma,
): Promise<ProjectMember> {
  const member = await getMembership(ctx.userId, projectId, tx);
  if (!member || !can(member.roles, capability)) {
    throw forbidden();
  }
  return member;
}
