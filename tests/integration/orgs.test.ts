// EXEMPLAR INTEGRATION TEST — services against real Postgres (srb_test).
// Pattern: resetDb() once per suite; unique data per test via factories; assert BOTH the
// domain effect AND the audit event; assert authorization failures.
import { beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/server/db";
import { AppError } from "@/server/errors";
import * as orgs from "@/server/services/orgs";
import * as projects from "@/server/services/projects";
import { resetDb } from "../db-utils";
import { createTestUser, createTestOrg, uniq } from "../factories";

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

  it("invites a new beta tester, omits the token from lists, and lets them own new projects", async () => {
    const owner = await createTestUser();
    const inviteeEmail = `${uniq("beta-tester")}@test.local`;
    const invitee = await createTestUser({ email: inviteeEmail });
    const org = await createTestOrg(owner.id);

    const invitation = await orgs.createOrganizationInvitation(ctx(owner.id), org.id, {
      email: inviteeEmail.toUpperCase(),
      role: "MEMBER",
    });
    expect(invitation.token).toHaveLength(43);
    expect(invitation.email).toBe(inviteeEmail);
    const ttlDays = (invitation.expiresAt.getTime() - Date.now()) / 86_400_000;
    expect(ttlDays).toBeGreaterThan(13.9);
    expect(ttlDays).toBeLessThanOrEqual(14);

    const createEvent = await prisma.auditEvent.findFirstOrThrow({
      where: {
        entityType: "OrganizationInvitation",
        entityId: invitation.id,
        action: "invitation.created",
      },
    });
    expect(JSON.stringify(createEvent.newValue)).not.toContain(invitation.token);

    const listed = await orgs.listOrganizationInvitations(ctx(owner.id), org.id);
    const listedInvitation = listed.find((row) => row.id === invitation.id);
    expect(listedInvitation).toBeDefined();
    expect(listedInvitation).not.toHaveProperty("token");

    const accepted = await orgs.acceptOrganizationInvitation(ctx(invitee.id), invitation.token);
    expect(accepted.organization.id).toBe(org.id);
    expect(accepted.membership).toMatchObject({ role: "MEMBER", status: "ACTIVE" });
    await expect(orgs.getOrg(ctx(invitee.id), org.id)).resolves.toMatchObject({
      id: org.id,
      myRole: "MEMBER",
    });

    // Any active organization member may create a project and becomes its full-access Owner.
    const project = await projects.createProject(ctx(invitee.id), org.id, {
      title: "Beta tester project",
      reviewType: "SYSTEMATIC_REVIEW",
    });
    const projectMembership = await prisma.projectMember.findUniqueOrThrow({
      where: { projectId_userId: { projectId: project.id, userId: invitee.id } },
    });
    expect(projectMembership.roles).toEqual(["OWNER"]);

    await prisma.auditEvent.findFirstOrThrow({
      where: {
        entityType: "OrganizationInvitation",
        entityId: invitation.id,
        action: "invitation.accepted",
        userId: invitee.id,
      },
    });
    await expectAppError(
      orgs.acceptOrganizationInvitation(ctx(invitee.id), invitation.token),
      "INVALID_STATE",
    );
  });

  it("limits organization invitations to managers and scopes revocation to the organization", async () => {
    const owner = await createTestUser();
    const member = await createTestUser();
    const org = await createTestOrg(owner.id);
    await orgs.addOrgMember(ctx(owner.id), org.id, { email: member.email, role: "MEMBER" });

    await expectAppError(
      orgs.createOrganizationInvitation(ctx(member.id), org.id, {
        email: `${uniq("blocked")}@test.local`,
        role: "MEMBER",
      }),
      "FORBIDDEN",
    );
    await expectAppError(orgs.listOrganizationInvitations(ctx(member.id), org.id), "FORBIDDEN");

    const invitation = await orgs.createOrganizationInvitation(ctx(owner.id), org.id, {
      email: `${uniq("invitee")}@test.local`,
      role: "ADMIN",
    });
    const otherOwner = await createTestUser();
    const otherOrg = await createTestOrg(otherOwner.id);
    await expectAppError(
      orgs.revokeOrganizationInvitation(ctx(otherOwner.id), otherOrg.id, invitation.id),
      "NOT_FOUND",
    );

    const revoked = await orgs.revokeOrganizationInvitation(ctx(owner.id), org.id, invitation.id);
    expect(revoked.revokedAt).not.toBeNull();
    expect(revoked).not.toHaveProperty("token");
    await prisma.auditEvent.findFirstOrThrow({
      where: {
        entityType: "OrganizationInvitation",
        entityId: invitation.id,
        action: "invitation.revoked",
      },
    });
  });

  it("does not consume an organization invitation for the wrong email and rejects expiry", async () => {
    const owner = await createTestUser();
    const invitee = await createTestUser();
    const wrongUser = await createTestUser();
    const org = await createTestOrg(owner.id);
    const invitation = await orgs.createOrganizationInvitation(ctx(owner.id), org.id, {
      email: invitee.email,
      role: "ADMIN",
    });

    await expectAppError(
      orgs.acceptOrganizationInvitation(ctx(wrongUser.id), invitation.token),
      "FORBIDDEN",
    );
    const stillPending = await prisma.organizationInvitation.findUniqueOrThrow({
      where: { id: invitation.id },
    });
    expect(stillPending.acceptedAt).toBeNull();

    await prisma.organizationInvitation.update({
      where: { id: invitation.id },
      data: { expiresAt: new Date(Date.now() - 1_000) },
    });
    await expectAppError(
      orgs.acceptOrganizationInvitation(ctx(invitee.id), invitation.token),
      "INVALID_STATE",
    );
    await expectAppError(
      orgs.acceptOrganizationInvitation(ctx(invitee.id), "unknown-token"),
      "NOT_FOUND",
    );
  });
});
