import { createHash } from "node:crypto";
import { compare } from "bcryptjs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { prisma } from "@/server/db";
import { requestPasswordReset, resetPassword, resetPasswordSchema } from "@/server/services/users/password-reset";
import { passwordSessionToken } from "@/server/auth/password-session";
import { POST as forgotRoute } from "@/app/api/auth/forgot-password/route";
import { resetDb } from "../db-utils";
import { createTestUser } from "../factories";

const send = vi.fn();
const digest = (token: string) => createHash("sha256").update(token).digest("hex");
function emailedToken(index = 0) {
  const body = JSON.parse(send.mock.calls[index]![1]!.body);
  const link = body.text.match(/https:\/\/synthesis\.example\/reset-password#[^\s]+/)[0];
  return new URLSearchParams(new URL(link).hash.slice(1)).get("token")!;
}
async function request(email: string) {
  return forgotRoute(new Request("https://untrusted.example/api/auth/forgot-password", {
    method: "POST", body: JSON.stringify({ email }),
  }));
}

beforeEach(async () => {
  await resetDb();
  vi.stubEnv("APP_URL", "https://synthesis.example");
  vi.stubEnv("EMAIL_FROM", "Synthesis <accounts@synthesis.example>");
  vi.stubEnv("RESEND_API_KEY", "test-key");
  send.mockReset().mockResolvedValue(new Response(JSON.stringify({ id: "mail-test" }), { status: 200 }));
  vi.stubGlobal("fetch", send);
});
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.restoreAllMocks(); });

describe("password reset", () => {
  it("sends to the normalized account using a trusted origin, stores only a hash and hides account existence", async () => {
    const user = await createTestUser({ email: "reviewer@example.com" });
    const known = await request(" REVIEWER@example.com ");
    const unknown = await request("missing@example.com");
    expect(known.status).toBe(200);
    expect(await known.json()).toEqual(await unknown.json());
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0]![0]).toBe("https://api.resend.com/emails");
    expect(JSON.parse(send.mock.calls[0]![1]!.body).to).toEqual([user.email]);
    const token = emailedToken();
    const stored = await prisma.passwordResetToken.findUniqueOrThrow({ where: { userId: user.id } });
    expect(stored.tokenHash).toBe(digest(token));
    expect(stored.tokenHash).not.toBe(token);
    expect(stored.expiresAt.getTime() - stored.createdAt.getTime()).toBe(30 * 60_000);
  });

  it("serializes concurrent requests and replaces older links after the cooldown", async () => {
    const user = await createTestUser();
    await Promise.all(Array.from({ length: 4 }, () => requestPasswordReset({ email: user.email })));
    expect(send).toHaveBeenCalledTimes(1);
    const first = emailedToken();
    await prisma.passwordResetToken.update({ where: { userId: user.id }, data: { createdAt: new Date(Date.now() - 61_000) } });
    await requestPasswordReset({ email: user.email });
    expect(send).toHaveBeenCalledTimes(2);
    await expect(resetPassword({ token: first, password: "new-password-123" })).rejects.toThrow("invalid or has expired");
    await expect(resetPassword({ token: emailedToken(1), password: "new-password-123" })).resolves.toBeUndefined();
  });

  it("changes the password once, records a safe audit event, and invalidates existing sessions", async () => {
    const user = await createTestUser();
    expect(await passwordSessionToken({ token: { sub: user.id } })).not.toBeNull();
    await requestPasswordReset({ email: user.email });
    const token = emailedToken();
    await resetPassword({ token, password: "new-password-123" });
    const updated = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(await compare("new-password-123", updated.passwordHash)).toBe(true);
    expect(await compare("test-password-123", updated.passwordHash)).toBe(false);
    await expect(resetPassword({ token, password: "another-password-123" })).rejects.toThrow("invalid or has expired");
    expect(await passwordSessionToken({ token: { sub: user.id } })).toBeNull();
    expect(await passwordSessionToken({ token: {}, user: { id: user.id, passwordVersion: null } })).toBeNull();
    const current = await passwordSessionToken({ token: {}, user: { id: user.id, passwordVersion: updated.passwordChangedAt!.toISOString() } });
    expect(current?.sub).toBe(user.id);
    const event = await prisma.auditEvent.findFirstOrThrow({ where: { action: "user.password_reset" } });
    expect(event.userId).toBe(user.id);
    expect(JSON.stringify(event)).not.toContain(token);
    expect(JSON.stringify(event)).not.toContain("new-password-123");
    expect(await prisma.passwordResetToken.count()).toBe(0);
  });

  it("permits only one concurrent redemption", async () => {
    const user = await createTestUser();
    await requestPasswordReset({ email: user.email });
    const input = { token: emailedToken(), password: "new-password-123" };
    const results = await Promise.allSettled([resetPassword(input), resetPassword(input)]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((r) => r.status === "rejected")).toHaveLength(1);
    expect(await prisma.auditEvent.count({ where: { action: "user.password_reset" } })).toBe(1);
  });

  it("rejects expired, unknown, malformed tokens and short or bcrypt-truncated passwords", async () => {
    const user = await createTestUser();
    await requestPasswordReset({ email: user.email });
    const token = emailedToken();
    await prisma.passwordResetToken.update({ where: { userId: user.id }, data: { expiresAt: new Date(0) } });
    for (const value of [token, "a".repeat(64)]) {
      await expect(resetPassword({ token: value, password: "new-password-123" })).rejects.toThrow("invalid or has expired");
    }
    expect(resetPasswordSchema.safeParse({ token: "bad", password: "new-password-123" }).success).toBe(false);
    expect(resetPasswordSchema.safeParse({ token, password: "short" }).success).toBe(false);
    expect(resetPasswordSchema.safeParse({ token, password: "😀".repeat(19) }).success).toBe(false);
    expect((await prisma.user.findUniqueOrThrow({ where: { id: user.id } })).passwordHash).toBe(user.passwordHash);
  });

  it("rolls back password changes and token consumption if the audit cannot be written", async () => {
    const user = await createTestUser();
    await requestPasswordReset({ email: user.email });
    const token = emailedToken();
    // A trigger exercises the real transaction rollback instead of mocking Prisma.
    await prisma.$executeRawUnsafe(`CREATE FUNCTION reject_reset_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'test audit failure'; END $$`);
    await prisma.$executeRawUnsafe(`CREATE TRIGGER reject_reset_audit BEFORE INSERT ON "AuditEvent" FOR EACH ROW EXECUTE FUNCTION reject_reset_audit()`);
    try {
      await expect(resetPassword({ token, password: "new-password-123" })).rejects.toThrow();
      expect((await prisma.user.findUniqueOrThrow({ where: { id: user.id } })).passwordHash).toBe(user.passwordHash);
      expect(await prisma.passwordResetToken.count({ where: { tokenHash: digest(token) } })).toBe(1);
    } finally {
      await prisma.$executeRawUnsafe(`DROP TRIGGER reject_reset_audit ON "AuditEvent"`);
      await prisma.$executeRawUnsafe(`DROP FUNCTION reject_reset_audit()`);
    }
  });

  it("keeps delivery errors generic, invalidates failed links, and retains the cooldown", async () => {
    const user = await createTestUser();
    send.mockResolvedValue(new Response("provider error", { status: 503 }));
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const known = await request(user.email);
    const unknown = await request("missing@example.com");
    expect(known.status).toBe(200);
    expect(await known.json()).toEqual(await unknown.json());
    await request(user.email);
    expect(send).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledOnce();
    expect(JSON.stringify(log.mock.calls)).not.toContain(user.email);
    await expect(resetPassword({ token: emailedToken(), password: "new-password-123" })).rejects.toThrow("invalid or has expired");
  });

  it("reports configuration errors uniformly without issuing a token", async () => {
    const user = await createTestUser();
    for (const [name, value] of [["RESEND_API_KEY", ""], ["APP_URL", "http://public.example"]] as const) {
      vi.stubEnv(name, value);
      const known = await request(user.email);
      const unknown = await request("missing@example.com");
      expect(known.status).toBe(422);
      expect(await known.json()).toEqual(await unknown.json());
      vi.stubEnv("RESEND_API_KEY", "test-key");
    }
    expect(send).not.toHaveBeenCalled();
    expect(await prisma.passwordResetToken.count()).toBe(0);
  });
});
