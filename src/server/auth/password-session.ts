import type { User } from "next-auth";
import type { JWT } from "next-auth/jwt";
import { prisma } from "@/server/db";

export async function passwordSessionToken({ token, user }: { token: JWT; user?: User }): Promise<JWT | null> {
  if (user?.id) {
    token.sub = user.id;
    // Capture the version read alongside the password hash during authorization.
    token.passwordVersion = user.passwordVersion ?? null;
  }
  if (!token.sub) return null;
  const current = await prisma.user.findUnique({
    where: { id: token.sub },
    select: { passwordChangedAt: true },
  });
  if (!current) return null;
  const version = current.passwordChangedAt?.toISOString() ?? null;
  // Legacy sessions have no version and remain valid only until the first reset.
  return (token.passwordVersion ?? null) === version ? token : null;
}
