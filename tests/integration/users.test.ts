import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/server/db";
import { AppError } from "@/server/errors";
import { createUser } from "@/server/services/users";
import { resetDb } from "../db-utils";
import { createTestOrg, createTestProject, createTestUser, uniq } from "../factories";

const originalAllowlist = process.env.PILOT_EMAIL_ALLOWLIST;

async function expectForbidden(promise: Promise<unknown>) {
  try {
    await promise;
    expect.fail("expected signup to be forbidden");
  } catch (err) {
    if (!(err instanceof AppError)) throw err;
    expect(err.code).toBe("FORBIDDEN");
  }
}

describe("pilot signup access", () => {
  beforeAll(async () => {
    await resetDb();
  });

  afterAll(() => {
    if (originalAllowlist === undefined) delete process.env.PILOT_EMAIL_ALLOWLIST;
    else process.env.PILOT_EMAIL_ALLOWLIST = originalAllowlist;
  });

  it("allows an explicitly allowlisted owner and rejects an unknown email", async () => {
    const ownerEmail = `${uniq("pilot-owner")}@example.com`;
    process.env.PILOT_EMAIL_ALLOWLIST = ownerEmail.toUpperCase();

    await expect(
      createUser({ email: ownerEmail, name: "Pilot Owner", password: "pilot-password-123" }),
    ).resolves.toMatchObject({ email: ownerEmail });

    await expectForbidden(
      createUser({
        email: `${uniq("unknown")}@example.com`,
        name: "Unknown User",
        password: "pilot-password-123",
      }),
    );
  });

  it("allows a collaborator with an active project invitation", async () => {
    const owner = await createTestUser();
    const org = await createTestOrg(owner.id);
    const project = await createTestProject(org.id, owner.id);
    const inviteeEmail = `${uniq("invitee")}@example.com`;
    process.env.PILOT_EMAIL_ALLOWLIST = `${uniq("different")}@example.com`;

    await prisma.projectInvitation.create({
      data: {
        projectId: project.id,
        email: inviteeEmail,
        roles: ["REVIEWER"],
        token: uniq("token"),
        invitedById: owner.id,
        expiresAt: new Date(Date.now() + 60_000),
      },
    });

    await expect(
      createUser({
        email: inviteeEmail,
        name: "Invited Reviewer",
        password: "pilot-password-123",
      }),
    ).resolves.toMatchObject({ email: inviteeEmail });
  });

  it("allows a beta tester with an active organization invitation", async () => {
    const owner = await createTestUser();
    const org = await createTestOrg(owner.id);
    const inviteeEmail = `${uniq("org-invitee")}@example.com`;
    process.env.PILOT_EMAIL_ALLOWLIST = `${uniq("different")}@example.com`;

    await prisma.organizationInvitation.create({
      data: {
        orgId: org.id,
        email: inviteeEmail,
        role: "MEMBER",
        token: uniq("org-token"),
        invitedById: owner.id,
        expiresAt: new Date(Date.now() + 60_000),
      },
    });

    await expect(
      createUser({
        email: inviteeEmail,
        name: "Invited Beta Tester",
        password: "pilot-password-123",
      }),
    ).resolves.toMatchObject({ email: inviteeEmail });
  });

  it("does not unlock signup with an expired or revoked organization invitation", async () => {
    const owner = await createTestUser();
    const org = await createTestOrg(owner.id);
    const expiredEmail = `${uniq("expired-org-invitee")}@example.com`;
    const revokedEmail = `${uniq("revoked-org-invitee")}@example.com`;
    process.env.PILOT_EMAIL_ALLOWLIST = `${uniq("different")}@example.com`;

    await prisma.organizationInvitation.createMany({
      data: [
        {
          orgId: org.id,
          email: expiredEmail,
          role: "MEMBER",
          token: uniq("expired-org-token"),
          invitedById: owner.id,
          expiresAt: new Date(Date.now() - 60_000),
        },
        {
          orgId: org.id,
          email: revokedEmail,
          role: "MEMBER",
          token: uniq("revoked-org-token"),
          invitedById: owner.id,
          expiresAt: new Date(Date.now() + 60_000),
          revokedAt: new Date(),
        },
      ],
    });

    await expectForbidden(
      createUser({
        email: expiredEmail,
        name: "Expired Invitee",
        password: "pilot-password-123",
      }),
    );
    await expectForbidden(
      createUser({
        email: revokedEmail,
        name: "Revoked Invitee",
        password: "pilot-password-123",
      }),
    );
  });
});
