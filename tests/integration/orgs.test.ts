// EXEMPLAR INTEGRATION TEST — services against real Postgres (srb_test).
// Pattern: resetDb() once per suite; unique data per test via factories; assert BOTH the
// domain effect AND the audit event; assert authorization failures.
import { beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/server/db";
import { AppError } from "@/server/errors";
import * as orgs from "@/server/services/orgs";
import { resetDb } from "../db-utils";
import { createTestUser, createTestOrg } from "../factories";

const ctx = (userId: string) => ({ userId });

async function expectAppError(promise: Promise<unknown>, code: string) {
  try {
    await promise;
    expect.fail(`expected AppError(${code}) but call succeeded`);
  } catch (err) {
    if (!(err instanceof AppError)) throw err;
    expect(err.code).toBe(code);
  }
}

describe("orgs service", () => {
  beforeAll(async () => {
    await resetDb();
  });

  it("creates an org with the creator as OWNER and audits it", async () => {
    const user = await createTestUser();
    const org = await orgs.createOrg(ctx(user.id), { name: "Pulmonary Evidence Group" });

    expect(org.slug).toMatch(/^pulmonary-evidence-group/);
    const member = await prisma.organizationMember.findUniqueOrThrow({
      where: { orgId_userId: { orgId: org.id, userId: user.id } },
    });
    expect(member.role).toBe("OWNER");

    const event = await prisma.auditEvent.findFirstOrThrow({
      where: { entityType: "Organization", entityId: org.id, action: "org.created" },
    });
    expect(event.userId).toBe(user.id);
  });

  it("non-members get 404, members can read", async () => {
    const owner = await createTestUser();
    const stranger = await createTestUser();
    const org = await createTestOrg(owner.id);

    await expect(orgs.getOrg(ctx(owner.id), org.id)).resolves.toMatchObject({ id: org.id });
    await expectAppError(orgs.getOrg(ctx(stranger.id), org.id), "NOT_FOUND");
  });

  it("only OWNER/ADMIN can add members; role change and removal are audited", async () => {
    const owner = await createTestUser();
    const invitee = await createTestUser();
    const org = await createTestOrg(owner.id);

    await orgs.addOrgMember(ctx(owner.id), org.id, { email: invitee.email, role: "MEMBER" });
    // plain MEMBER cannot manage members
    const third = await createTestUser();
    await expectAppError(
      orgs.addOrgMember(ctx(invitee.id), org.id, { email: third.email, role: "MEMBER" }),
      "FORBIDDEN",
    );

    await orgs.updateOrgMemberRole(ctx(owner.id), org.id, invitee.id, { role: "ADMIN" });
    const roleEvent = await prisma.auditEvent.findFirstOrThrow({
      where: { action: "member.roles_changed", userId: owner.id },
      orderBy: { createdAt: "desc" },
    });
    expect(roleEvent.previousValue).toMatchObject({ role: "MEMBER" });
    expect(roleEvent.newValue).toMatchObject({ role: "ADMIN" });

    await orgs.removeOrgMember(ctx(owner.id), org.id, invitee.id);
    const removed = await prisma.organizationMember.findUniqueOrThrow({
      where: { orgId_userId: { orgId: org.id, userId: invitee.id } },
    });
    expect(removed.status).toBe("REMOVED");
    // removed member has no access
    await expectAppError(orgs.getOrg(ctx(invitee.id), org.id), "NOT_FOUND");
  });

  it("refuses to demote or remove the last owner", async () => {
    const owner = await createTestUser();
    const org = await createTestOrg(owner.id);
    await expectAppError(
      orgs.updateOrgMemberRole(ctx(owner.id), org.id, owner.id, { role: "MEMBER" }),
      "INVALID_STATE",
    );
    await expectAppError(orgs.removeOrgMember(ctx(owner.id), org.id, owner.id), "INVALID_STATE");
  });
});
