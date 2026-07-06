import { hashSync } from "bcryptjs";
import type { OrgRole, ProjectRole, ReviewType } from "@prisma/client";
import { prisma } from "@/server/db";

// Low-level factories for integration tests. Workflow behavior under test should go through
// services; these exist only to establish preconditions quickly.

let seq = 0;
export const uniq = (prefix: string) => `${prefix}-${Date.now().toString(36)}-${++seq}`;

const PASSWORD_HASH = hashSync("test-password-123", 4); // cheap cost for tests

export async function createTestUser(overrides: { email?: string; name?: string } = {}) {
  return prisma.user.create({
    data: {
      email: overrides.email ?? `${uniq("user")}@test.local`,
      name: overrides.name ?? "Test User",
      passwordHash: PASSWORD_HASH,
    },
  });
}

export async function createTestOrg(ownerId: string, name = "Test Org") {
  const org = await prisma.organization.create({
    data: { name, slug: uniq("org"), createdById: ownerId },
  });
  await prisma.organizationMember.create({
    data: { orgId: org.id, userId: ownerId, role: "OWNER" },
  });
  return org;
}

export async function addOrgMember(orgId: string, userId: string, role: OrgRole = "MEMBER") {
  return prisma.organizationMember.create({ data: { orgId, userId, role } });
}

export async function createTestProject(
  orgId: string,
  ownerId: string,
  overrides: Partial<{ title: string; reviewType: ReviewType }> = {},
) {
  const project = await prisma.project.create({
    data: {
      orgId,
      title: overrides.title ?? uniq("Project"),
      reviewType: overrides.reviewType ?? "SYSTEMATIC_REVIEW",
      createdById: ownerId,
    },
  });
  await prisma.projectMember.create({
    data: { projectId: project.id, userId: ownerId, roles: ["OWNER"] },
  });
  return project;
}

export async function addProjectMember(
  projectId: string,
  userId: string,
  roles: ProjectRole[],
) {
  return prisma.projectMember.create({ data: { projectId, userId, roles } });
}

// A ready-made team: owner + 2 reviewers + adjudicator, org + project wired up.
export async function createProjectWithTeam() {
  const owner = await createTestUser({ name: "Owner" });
  const reviewer1 = await createTestUser({ name: "Reviewer One" });
  const reviewer2 = await createTestUser({ name: "Reviewer Two" });
  const adjudicator = await createTestUser({ name: "Adjudicator" });
  const org = await createTestOrg(owner.id);
  for (const u of [reviewer1, reviewer2, adjudicator]) await addOrgMember(org.id, u.id);
  const project = await createTestProject(org.id, owner.id);
  await addProjectMember(project.id, reviewer1.id, ["REVIEWER"]);
  await addProjectMember(project.id, reviewer2.id, ["REVIEWER"]);
  await addProjectMember(project.id, adjudicator.id, ["ADJUDICATOR"]);
  return { owner, reviewer1, reviewer2, adjudicator, org, project };
}

export async function createTestCitation(
  projectId: string,
  overrides: Partial<{
    title: string;
    year: number;
    doi: string | null;
    pmid: string | null;
    abstract: string;
    journal: string;
  }> = {},
) {
  const title = overrides.title ?? `${uniq("Citation")} effects of X on Y`;
  return prisma.citation.create({
    data: {
      projectId,
      title,
      normalizedTitle: title.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim(),
      authors: [{ family: "Smith", given: "J" }],
      year: overrides.year ?? 2020,
      journal: overrides.journal ?? "Journal of Testing",
      abstract: overrides.abstract ?? "Background: test. Methods: test. Results: test.",
      doi: overrides.doi ?? null,
      pmid: overrides.pmid ?? null,
    },
  });
}
