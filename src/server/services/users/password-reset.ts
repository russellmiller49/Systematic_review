import { createHash, randomBytes } from "node:crypto";
import { hash } from "bcryptjs";
import { z } from "zod";
import { prisma } from "@/server/db";
import { validationError } from "@/server/errors";
import { passwordResetEmailConfig, sendPasswordResetEmail } from "@/server/email/password-reset";
import { record, AuditActions } from "@/server/services/audit";

export const forgotPasswordSchema = z.object({
  email: z.string().trim().email().max(320).transform((email) => email.toLowerCase()),
});
export const resetPasswordSchema = z.object({
  token: z.string().regex(/^[a-f0-9]{64}$/),
  password: z.string().min(10, "Password must be at least 10 characters").max(200)
    .refine((password) => Buffer.byteLength(password, "utf8") <= 72,
      "Password must be at most 72 bytes"),
});
export const RESET_REQUEST_MESSAGE =
  "If an account exists for that email, we’ll send a password reset link. Check your inbox and spam folder. Please wait a minute before requesting another link.";
const digest = (token: string) => createHash("sha256").update(token).digest("hex");
const invalidLink = () => validationError("This reset link is invalid or has expired. Please request a new link.");

export async function requestPasswordReset(input: z.infer<typeof forgotPasswordSchema>) {
  const { email } = forgotPasswordSchema.parse(input);
  // Check configuration for every address, so misconfiguration cannot reveal account existence.
  const config = passwordResetEmailConfig();
  const user = await prisma.user.findUnique({ where: { email }, select: { id: true } });
  if (!user) return;
  const token = randomBytes(32).toString("hex");
  const tokenHash = digest(token);
  const issued = await prisma.$transaction(async (tx) => {
    // Serialize requests and redemption for this account, including across server instances.
    await tx.$queryRaw`SELECT "id" FROM "User" WHERE "id" = ${user.id} FOR UPDATE`;
    const previous = await tx.passwordResetToken.findUnique({ where: { userId: user.id } });
    const now = new Date();
    if (previous && now.getTime() - previous.createdAt.getTime() < 60_000) return false;
    const data = { tokenHash, expiresAt: new Date(now.getTime() + 30 * 60_000), createdAt: now };
    await tx.passwordResetToken.upsert({
      where: { userId: user.id },
      create: { userId: user.id, ...data },
      update: data,
    });
    return true;
  });
  if (!issued) return;
  try {
    await sendPasswordResetEmail(email, token, config);
  } catch {
    // Preserve the cooldown even on delivery failure; never expose account existence.
    // Invalidate the undelivered link without touching a newer request.
    await prisma.passwordResetToken.updateMany({
      where: { userId: user.id, tokenHash },
      data: { expiresAt: new Date(0) },
    });
    console.error("Password reset email delivery failed; check Resend configuration and availability.");
  }
}

export async function resetPassword(input: z.infer<typeof resetPasswordSchema>) {
  const { token, password } = resetPasswordSchema.parse(input);
  const tokenHash = digest(token);
  const candidate = await prisma.passwordResetToken.findUnique({ where: { tokenHash } });
  if (!candidate || candidate.expiresAt <= new Date()) throw invalidLink();
  const passwordHash = await hash(password, 12);
  await prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT "id" FROM "User" WHERE "id" = ${candidate.userId} FOR UPDATE`;
    const consumed = await tx.passwordResetToken.deleteMany({
      where: { tokenHash, expiresAt: { gt: new Date() } },
    });
    if (consumed.count !== 1) throw invalidLink();
    await tx.user.update({
      where: { id: candidate.userId },
      data: { passwordHash, passwordChangedAt: new Date() },
    });
    await record(tx, {
      userId: candidate.userId,
      entityType: "User",
      entityId: candidate.userId,
      action: AuditActions.USER_PASSWORD_RESET,
    });
  });
}
