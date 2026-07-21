import { hash } from "bcryptjs";
import { z } from "zod";
import { prisma } from "@/server/db";
import { conflict, forbidden } from "@/server/errors";
import * as audit from "@/server/services/audit";
import { AuditActions } from "@/server/services/audit";

export const signUpSchema = z.object({
  email: z.string().email().max(320),
  name: z.string().trim().min(1).max(200),
  password: z.string().min(10, "Password must be at least 10 characters").max(200),
});

export type SignUpInput = z.infer<typeof signUpSchema>;

export function parsePilotEmailAllowlist(raw: string | undefined): Set<string> {
  return new Set(
    (raw ?? "")
      .split(",")
      .map((email) => email.trim().toLowerCase())
      .filter(Boolean),
  );
}

async function requirePilotSignupAccess(email: string) {
  const allowlist = parsePilotEmailAllowlist(process.env.PILOT_EMAIL_ALLOWLIST);
  if (allowlist.size === 0 || allowlist.has(email)) return;

  // Once an owner creates an organization or project invitation, that email may register
  // without a deploy-time allowlist change. The token is still required to join its target.
  const activeInvitationWhere = {
    email,
    acceptedAt: null,
    revokedAt: null,
    expiresAt: { gt: new Date() },
  };
  const [organizationInvitation, projectInvitation] = await Promise.all([
    prisma.organizationInvitation.findFirst({
      where: activeInvitationWhere,
      select: { id: true },
    }),
    prisma.projectInvitation.findFirst({
      where: activeInvitationWhere,
      select: { id: true },
    }),
  ]);
  if (!organizationInvitation && !projectInvitation) {
    throw forbidden("This pilot is invitation-only. Ask a workspace or project owner for access.");
  }
}

export async function createUser(input: SignUpInput) {
  const email = input.email.toLowerCase().trim();
  await requirePilotSignupAccess(email);
  const passwordHash = await hash(input.password, 12);

  return prisma.$transaction(async (tx) => {
    const existing = await tx.user.findUnique({ where: { email } });
    if (existing) throw conflict("An account with this email already exists");

    const user = await tx.user.create({
      data: { email, name: input.name, passwordHash },
    });

    await audit.record(tx, {
      userId: user.id,
      entityType: "User",
      entityId: user.id,
      action: AuditActions.USER_CREATED,
      newValue: { email: user.email, name: user.name },
    });

    return { id: user.id, email: user.email, name: user.name };
  });
}

export async function getMe(userId: string) {
  const user = await prisma.user.findUniqueOrThrow({
    where: { id: userId },
    select: { id: true, email: true, name: true, createdAt: true },
  });
  const orgMemberships = await prisma.organizationMember.findMany({
    where: { userId, status: "ACTIVE" },
    include: { org: { select: { id: true, name: true, slug: true } } },
  });
  const projectMemberships = await prisma.projectMember.findMany({
    where: { userId, status: "ACTIVE" },
    include: { project: { select: { id: true, title: true, orgId: true, status: true } } },
  });
  return { user, orgMemberships, projectMemberships };
}
