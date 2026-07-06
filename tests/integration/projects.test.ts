// Integration tests: projects, project members, invitations (docs/09 R9/R10/R11).
// Run against an isolated database: srb_test_projects (see agent sandbox instructions).
import { beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/server/db";
import { AppError } from "@/server/errors";
import * as projects from "@/server/services/projects";
import { resetDb } from "../db-utils";
import { createTestUser, createTestOrg, addOrgMember, uniq } from "../factories";

const ctx = (userId: string) => ({ userId });

async function expectAppError(promise: Promise<unknown>, ...codes: string[]) {
  try {
    await promise;
    expect.fail(`expected AppError(${codes.join("|")}) but call succeeded`);
  } catch (err) {
    if (!(err instanceof AppError)) throw err;
    expect(codes).toContain(err.code);
  }
}

// Owner + org + project created through the real service (not factories) so stage/protocol
// bootstrap behavior is what's under test everywhere else in this suite.
async function createProjectFixture(input: Partial<Parameters<typeof projects.createProject>[2]> = {}) {
  const owner = await createTestUser({ name: "Owner" });
  const org = await createTestOrg(owner.id);
  const project = await projects.createProject(ctx(owner.id), org.id, {
    title: uniq("Project"),
    reviewType: "SYSTEMATIC_REVIEW",
    ...input,
  });
  return { owner, org, project };
}

describe("projects service", () => {
  beforeAll(async () => {
    await resetDb();
  });

  describe("creation", () => {
    it("creates project with defaults: both stages, protocol row, OWNER membership, audit", async () => {
      const { owner, org, project } = await createProjectFixture();

      expect(project.status).toBe("PLANNING");
      expect(project.orgId).toBe(org.id);

      const stages = await prisma.screeningStage.findMany({
        where: { projectId: project.id },
        orderBy: { type: "asc" },
      });
      expect(stages).toHaveLength(2);
      expect(stages.map((s) => s.type).sort()).toEqual(["FULL_TEXT", "TITLE_ABSTRACT"]);
      for (const stage of stages) {
        expect(stage.reviewersPerCitation).toBe(2); // dualScreening default true
        expect(stage.blinded).toBe(true);
        expect(stage.maybeGeneratesConflict).toBe(true);
      }

      const protocol = await prisma.protocol.findUnique({ where: { projectId: project.id } });
      expect(protocol).not.toBeNull();

      const member = await prisma.projectMember.findUniqueOrThrow({
        where: { projectId_userId: { projectId: project.id, userId: owner.id } },
      });
      expect(member.roles).toEqual(["OWNER"]);
      expect(member.status).toBe("ACTIVE");

      const event = await prisma.auditEvent.findFirstOrThrow({
        where: { entityType: "Project", entityId: project.id, action: "project.created" },
      });
      expect(event.userId).toBe(owner.id);
      expect(event.projectId).toBe(project.id);
    });

    it("dualScreening=false forces reviewersPerCitation to 1 on both stages", async () => {
      const { project } = await createProjectFixture({
        dualScreening: false,
        reviewersPerCitation: 3,
        blindedScreening: false,
      });
      const stages = await prisma.screeningStage.findMany({
        where: { projectId: project.id },
      });
      expect(stages).toHaveLength(2);
      for (const stage of stages) {
        expect(stage.reviewersPerCitation).toBe(1);
        expect(stage.blinded).toBe(false);
      }
    });

    it("non-org-members cannot create or list projects in the org", async () => {
      const { org } = await createProjectFixture();
      const stranger = await createTestUser();
      await expectAppError(
        projects.createProject(ctx(stranger.id), org.id, {
          title: uniq("Nope"),
          reviewType: "SCOPING_REVIEW",
        }),
        "NOT_FOUND",
      );
      await expectAppError(projects.listProjects(ctx(stranger.id), org.id), "NOT_FOUND");
    });

    it("org members see org projects with counts; getProject includes stages and my roles", async () => {
      const { owner, org, project } = await createProjectFixture();
      const colleague = await createTestUser();
      await addOrgMember(org.id, colleague.id);

      const list = await projects.listProjects(ctx(colleague.id), org.id);
      const row = list.find((p) => p.id === project.id);
      expect(row).toBeDefined();
      expect(row!._count.members).toBe(1);
      expect(row!._count.citations).toBe(0);

      const detail = await projects.getProject(ctx(owner.id), project.id);
      expect(detail.myRoles).toEqual(["OWNER"]);
      expect(detail.screeningStages).toHaveLength(2);

      // org member without a project membership cannot read project detail
      await expectAppError(projects.getProject(ctx(colleague.id), project.id), "FORBIDDEN");
    });
  });

  describe("update", () => {
    it("audits previous/new of only the changed fields", async () => {
      const { owner, project } = await createProjectFixture();
      const updated = await projects.updateProject(ctx(owner.id), project.id, {
        status: "SCREENING",
        researchQuestion: "Does X improve Y?",
      });
      expect(updated.status).toBe("SCREENING");

      const event = await prisma.auditEvent.findFirstOrThrow({
        where: { entityType: "Project", entityId: project.id, action: "project.updated" },
        orderBy: { createdAt: "desc" },
      });
      expect(event.previousValue).toMatchObject({ status: "PLANNING", researchQuestion: null });
      expect(event.newValue).toMatchObject({
        status: "SCREENING",
        researchQuestion: "Does X improve Y?",
      });
      // title unchanged → not in the audit payload
      expect(event.newValue).not.toHaveProperty("title");
    });
  });

  describe("members", () => {
    it("adding a member requires the user to be an ACTIVE org member (422 otherwise)", async () => {
      const { owner, org, project } = await createProjectFixture();
      const outsider = await createTestUser();

      await expectAppError(
        projects.addProjectMember(ctx(owner.id), project.id, {
          email: outsider.email,
          roles: ["REVIEWER"],
        }),
        "INVALID_STATE",
      );

      await addOrgMember(org.id, outsider.id);
      const member = await projects.addProjectMember(ctx(owner.id), project.id, {
        email: outsider.email,
        roles: ["REVIEWER", "ADJUDICATOR"],
      });
      expect(member.roles).toEqual(["REVIEWER", "ADJUDICATOR"]);

      const event = await prisma.auditEvent.findFirstOrThrow({
        where: { entityType: "ProjectMember", entityId: member.id, action: "member.added" },
      });
      expect(event.projectId).toBe(project.id);
      expect(event.newValue).toMatchObject({ userId: outsider.id, roles: ["REVIEWER", "ADJUDICATOR"] });

      // adding again while ACTIVE → 409
      await expectAppError(
        projects.addProjectMember(ctx(owner.id), project.id, {
          email: outsider.email,
          roles: ["REVIEWER"],
        }),
        "CONFLICT",
      );
    });

    it("unknown email → 404; non-managers cannot add members", async () => {
      const { owner, org, project } = await createProjectFixture();
      const orgOnly = await createTestUser();
      await addOrgMember(org.id, orgOnly.id);
      await expectAppError(
        projects.addProjectMember(ctx(owner.id), project.id, {
          email: `${uniq("ghost")}@test.local`,
          roles: ["REVIEWER"],
        }),
        "NOT_FOUND",
      );
      // org member without project membership → 403
      await expectAppError(
        projects.addProjectMember(ctx(orgOnly.id), project.id, {
          email: orgOnly.email,
          roles: ["REVIEWER"],
        }),
        "FORBIDDEN",
      );
    });

    it("role changes are audited with previousValue", async () => {
      const { owner, org, project } = await createProjectFixture();
      const reviewer = await createTestUser();
      await addOrgMember(org.id, reviewer.id);
      const member = await projects.addProjectMember(ctx(owner.id), project.id, {
        email: reviewer.email,
        roles: ["REVIEWER"],
      });

      await projects.updateProjectMemberRoles(ctx(owner.id), project.id, reviewer.id, {
        roles: ["REVIEWER", "EXTRACTOR"],
      });
      const event = await prisma.auditEvent.findFirstOrThrow({
        where: {
          entityType: "ProjectMember",
          entityId: member.id,
          action: "member.roles_changed",
        },
        orderBy: { createdAt: "desc" },
      });
      expect(event.previousValue).toMatchObject({ roles: ["REVIEWER"] });
      expect(event.newValue).toMatchObject({ roles: ["REVIEWER", "EXTRACTOR"] });
    });

    it("soft-remove keeps the row and blocks project access", async () => {
      const { owner, org, project } = await createProjectFixture();
      const reviewer = await createTestUser();
      await addOrgMember(org.id, reviewer.id);
      await projects.addProjectMember(ctx(owner.id), project.id, {
        email: reviewer.email,
        roles: ["REVIEWER"],
      });

      // member can read before removal
      await expect(projects.getProject(ctx(reviewer.id), project.id)).resolves.toMatchObject({
        id: project.id,
      });

      await projects.removeProjectMember(ctx(owner.id), project.id, reviewer.id);

      const row = await prisma.projectMember.findUniqueOrThrow({
        where: { projectId_userId: { projectId: project.id, userId: reviewer.id } },
      });
      expect(row.status).toBe("REMOVED");
      expect(row.roles).toEqual(["REVIEWER"]); // history preserved

      await expectAppError(
        projects.getProject(ctx(reviewer.id), project.id),
        "FORBIDDEN",
        "NOT_FOUND",
      );

      const event = await prisma.auditEvent.findFirstOrThrow({
        where: { entityType: "ProjectMember", entityId: row.id, action: "member.removed" },
      });
      expect(event.previousValue).toMatchObject({ status: "ACTIVE" });

      // re-adding reactivates the same row
      const readded = await projects.addProjectMember(ctx(owner.id), project.id, {
        email: reviewer.email,
        roles: ["OBSERVER"],
      });
      expect(readded.id).toBe(row.id);
      expect(readded.status).toBe("ACTIVE");
      expect(readded.roles).toEqual(["OBSERVER"]);
    });

    it("refuses to demote or remove the last owner", async () => {
      const { owner, project } = await createProjectFixture();
      await expectAppError(
        projects.updateProjectMemberRoles(ctx(owner.id), project.id, owner.id, {
          roles: ["REVIEWER"],
        }),
        "INVALID_STATE",
      );
      await expectAppError(
        projects.removeProjectMember(ctx(owner.id), project.id, owner.id),
        "INVALID_STATE",
      );

      // with a second owner, demotion works
      const { owner: owner1, org, project: p2 } = await createProjectFixture();
      const owner2 = await createTestUser();
      await addOrgMember(org.id, owner2.id);
      await projects.addProjectMember(ctx(owner1.id), p2.id, {
        email: owner2.email,
        roles: ["OWNER"],
      });
      const demoted = await projects.updateProjectMemberRoles(ctx(owner1.id), p2.id, owner1.id, {
        roles: ["REVIEWER"],
      });
      expect(demoted.roles).toEqual(["REVIEWER"]);
    });

    it("R10: org-REMOVED user with an ACTIVE project row cannot access the project", async () => {
      const { owner, org, project } = await createProjectFixture();
      const reviewer = await createTestUser();
      await addOrgMember(org.id, reviewer.id);
      await projects.addProjectMember(ctx(owner.id), project.id, {
        email: reviewer.email,
        roles: ["REVIEWER"],
      });

      // remove from the ORG only; project row stays ACTIVE
      await prisma.organizationMember.update({
        where: { orgId_userId: { orgId: org.id, userId: reviewer.id } },
        data: { status: "REMOVED" },
      });
      const projectRow = await prisma.projectMember.findUniqueOrThrow({
        where: { projectId_userId: { projectId: project.id, userId: reviewer.id } },
      });
      expect(projectRow.status).toBe("ACTIVE");

      await expectAppError(projects.getProject(ctx(reviewer.id), project.id), "FORBIDDEN");
    });
  });

  describe("invitations (R11)", () => {
    it("full lifecycle: create returns token once, list omits it, accept creates project+org membership", async () => {
      const { owner, org, project } = await createProjectFixture();
      const inviteeEmail = `${uniq("invitee")}@test.local`;
      const invitee = await createTestUser({ email: inviteeEmail });

      const invitation = await projects.createInvitation(ctx(owner.id), project.id, {
        email: inviteeEmail.toUpperCase(), // service lowercases
        roles: ["REVIEWER"],
      });
      expect(invitation.token).toHaveLength(43); // 32 bytes base64url
      expect(invitation.email).toBe(inviteeEmail);
      const ttlDays = (invitation.expiresAt.getTime() - Date.now()) / 86_400_000;
      expect(ttlDays).toBeGreaterThan(13.9);
      expect(ttlDays).toBeLessThanOrEqual(14);

      const createEvent = await prisma.auditEvent.findFirstOrThrow({
        where: {
          entityType: "ProjectInvitation",
          entityId: invitation.id,
          action: "invitation.created",
        },
      });
      expect(JSON.stringify(createEvent.newValue)).not.toContain(invitation.token);

      // list never exposes the token
      const listed = await projects.listInvitations(ctx(owner.id), project.id);
      const row = listed.find((i) => i.id === invitation.id);
      expect(row).toBeDefined();
      expect(row).not.toHaveProperty("token");

      // accept
      const result = await projects.acceptInvitation(ctx(invitee.id), invitation.token);
      expect(result.project.id).toBe(project.id);
      expect(result.membership.roles).toEqual(["REVIEWER"]);

      const orgMember = await prisma.organizationMember.findUniqueOrThrow({
        where: { orgId_userId: { orgId: org.id, userId: invitee.id } },
      });
      expect(orgMember.status).toBe("ACTIVE");
      expect(orgMember.role).toBe("MEMBER");

      // R10 gate satisfied: invitee can now read the project
      await expect(projects.getProject(ctx(invitee.id), project.id)).resolves.toMatchObject({
        id: project.id,
        myRoles: ["REVIEWER"],
      });

      await prisma.auditEvent.findFirstOrThrow({
        where: {
          entityType: "ProjectInvitation",
          entityId: invitation.id,
          action: "invitation.accepted",
          userId: invitee.id,
        },
      });

      // reuse → INVALID_STATE
      await expectAppError(
        projects.acceptInvitation(ctx(invitee.id), invitation.token),
        "INVALID_STATE",
      );
    });

    it("expired invitation → INVALID_STATE", async () => {
      const { owner, project } = await createProjectFixture();
      const invitee = await createTestUser();
      const invitation = await projects.createInvitation(ctx(owner.id), project.id, {
        email: invitee.email,
        roles: ["REVIEWER"],
      });
      await prisma.projectInvitation.update({
        where: { id: invitation.id },
        data: { expiresAt: new Date(Date.now() - 1000) },
      });
      await expectAppError(
        projects.acceptInvitation(ctx(invitee.id), invitation.token),
        "INVALID_STATE",
      );
    });

    it("revoked invitation → INVALID_STATE; revoke is audited and scoped to the project", async () => {
      const { owner, project } = await createProjectFixture();
      const invitee = await createTestUser();
      const invitation = await projects.createInvitation(ctx(owner.id), project.id, {
        email: invitee.email,
        roles: ["REVIEWER"],
      });

      // R9: cannot revoke through a different project
      const { owner: otherOwner, project: otherProject } = await createProjectFixture();
      await expectAppError(
        projects.revokeInvitation(ctx(otherOwner.id), otherProject.id, invitation.id),
        "NOT_FOUND",
      );

      const revoked = await projects.revokeInvitation(ctx(owner.id), project.id, invitation.id);
      expect(revoked.revokedAt).not.toBeNull();
      expect(revoked).not.toHaveProperty("token");

      await prisma.auditEvent.findFirstOrThrow({
        where: {
          entityType: "ProjectInvitation",
          entityId: invitation.id,
          action: "invitation.revoked",
        },
      });

      await expectAppError(
        projects.acceptInvitation(ctx(invitee.id), invitation.token),
        "INVALID_STATE",
      );
      // double revoke → INVALID_STATE
      await expectAppError(
        projects.revokeInvitation(ctx(owner.id), project.id, invitation.id),
        "INVALID_STATE",
      );
    });

    it("wrong email → FORBIDDEN; unknown token → NOT_FOUND", async () => {
      const { owner, project } = await createProjectFixture();
      const invitee = await createTestUser();
      const wrongUser = await createTestUser();
      const invitation = await projects.createInvitation(ctx(owner.id), project.id, {
        email: invitee.email,
        roles: ["REVIEWER"],
      });
      await expectAppError(
        projects.acceptInvitation(ctx(wrongUser.id), invitation.token),
        "FORBIDDEN",
        "INVALID_STATE",
      );
      // wrong-email attempt must NOT consume the invitation
      const still = await prisma.projectInvitation.findUniqueOrThrow({
        where: { id: invitation.id },
      });
      expect(still.acceptedAt).toBeNull();

      await expectAppError(projects.acceptInvitation(ctx(invitee.id), "no-such-token"), "NOT_FOUND");
    });

    it("accept reactivates a REMOVED project member and a REMOVED org member", async () => {
      const { owner, org, project } = await createProjectFixture();
      const returning = await createTestUser();
      await addOrgMember(org.id, returning.id);
      await projects.addProjectMember(ctx(owner.id), project.id, {
        email: returning.email,
        roles: ["REVIEWER"],
      });
      await projects.removeProjectMember(ctx(owner.id), project.id, returning.id);
      await prisma.organizationMember.update({
        where: { orgId_userId: { orgId: org.id, userId: returning.id } },
        data: { status: "REMOVED" },
      });

      const invitation = await projects.createInvitation(ctx(owner.id), project.id, {
        email: returning.email,
        roles: ["EXTRACTOR"],
      });
      const result = await projects.acceptInvitation(ctx(returning.id), invitation.token);
      expect(result.membership.status).toBe("ACTIVE");
      expect(result.membership.roles).toEqual(["EXTRACTOR"]);

      const orgRow = await prisma.organizationMember.findUniqueOrThrow({
        where: { orgId_userId: { orgId: org.id, userId: returning.id } },
      });
      expect(orgRow.status).toBe("ACTIVE");

      await expect(projects.getProject(ctx(returning.id), project.id)).resolves.toMatchObject({
        id: project.id,
      });
    });

    it("non-managers (REVIEWER) cannot create or list invitations", async () => {
      const { owner, org, project } = await createProjectFixture();
      const reviewer = await createTestUser();
      await addOrgMember(org.id, reviewer.id);
      await projects.addProjectMember(ctx(owner.id), project.id, {
        email: reviewer.email,
        roles: ["REVIEWER"],
      });
      await expectAppError(
        projects.createInvitation(ctx(reviewer.id), project.id, {
          email: `${uniq("x")}@test.local`,
          roles: ["REVIEWER"],
        }),
        "FORBIDDEN",
      );
      await expectAppError(projects.listInvitations(ctx(reviewer.id), project.id), "FORBIDDEN");
    });
  });
});
