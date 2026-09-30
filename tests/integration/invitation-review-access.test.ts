import { beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/server/db";
import * as orgs from "@/server/services/orgs";
import * as projects from "@/server/services/projects";
import * as screening from "@/server/services/screening";
import * as pooled from "@/server/services/screening/pooled";
import * as quotas from "@/server/services/screening/quotas";
import { resetDb } from "../db-utils";
import {
  addOrgMember,
  createTestCitation,
  createTestOrg,
  createTestUser,
  uniq,
} from "../factories";

const ctx = (userId: string) => ({ userId });

async function family() {
  const owner = await createTestUser();
  const org = await createTestOrg(owner.id);
  const guideline = await projects.createProject(ctx(owner.id), org.id, {
    title: "Invitation screening guideline",
    reviewType: "GUIDELINE_EVIDENCE_REVIEW",
    isGuideline: true,
  });
  const picos = [];
  for (let i = 1; i <= 6; i++)
    picos.push(
      await projects.createSubProject(ctx(owner.id), guideline.id, {
        title: `PICO ${i}`,
        researchQuestion: `Does treatment ${i} improve the outcome?`,
      }),
    );
  const stage = await prisma.screeningStage.findUniqueOrThrow({
    where: {
      projectId_type: { projectId: picos[0]!.id, type: "TITLE_ABSTRACT" },
    },
  });
  const pool = await pooled.saveGuidelineScreeningPool(
    ctx(owner.id),
    guideline.id,
    {
      name: "PICO 2–6",
      projectIds: picos.slice(1).map((p) => p.id),
    },
  );
  return { owner, org, guideline, picos, stage, pool };
}

describe("explicit project and review access on workspace invitations", () => {
  beforeAll(resetDb);

  it("keeps issued links and applies family access and 250/400/no-target plans atomically on joining", async () => {
    const { owner, org, guideline, picos, stage, pool } = await family();
    for (const [target, scope] of [
      [250, { stageId: stage.id }],
      [400, { poolId: pool.id }],
      [null, { poolId: pool.id }],
    ] as const) {
      const email = `${uniq("pending-reviewer")}@test.local`;
      const invitation = await orgs.createOrganizationInvitation(
        ctx(owner.id),
        org.id,
        { email, role: "MEMBER" },
      );
      const configured =
        await orgs.configureOrganizationInvitationProjectAccess(
          ctx(owner.id),
          org.id,
          invitation.id,
          [
            {
              projectId: guideline.id,
              roles: ["REVIEWER"],
              quotas:
                target === null
                  ? [
                      { stageId: stage.id, target: null },
                      { poolId: pool.id, target: null },
                    ]
                  : [{ ...scope, target }],
            },
          ],
        );
      expect(configured).not.toHaveProperty("token");
      expect(
        await prisma.organizationInvitation.findUniqueOrThrow({
          where: { id: invitation.id },
        }),
      ).toMatchObject({
        token: invitation.token,
        acceptedAt: null,
      });
      const user = await createTestUser({ email });
      await orgs.acceptOrganizationInvitation(ctx(user.id), invitation.token);
      for (const project of [guideline, ...picos]) {
        expect(
          await projects.getProject(ctx(user.id), project.id),
        ).toMatchObject({ myRoles: ["REVIEWER"] });
      }
      expect(await quotas.quotaProgress(prisma, scope, user.id)).toEqual({
        target,
        completed: 0,
        remaining: target,
      });
      expect(
        await prisma.screeningAssignment.count({
          where: { reviewerId: user.id },
        }),
      ).toBe(0);
      expect(
        await prisma.auditEvent.count({
          where: { userId: user.id, action: "member.added" },
        }),
      ).toBe(7);
      await expect(
        orgs.acceptOrganizationInvitation(ctx(user.id), invitation.token),
      ).rejects.toMatchObject({ code: "INVALID_STATE" });
    }
  });

  it("supports continued ordinary and pooled reviews without a target and retains dual-review capacity and blinding", async () => {
    const { owner, org, guideline, picos, stage, pool } = await family();
    const users = [
      await createTestUser(),
      await createTestUser(),
      await createTestUser(),
    ];
    for (const user of users) {
      await addOrgMember(org.id, user.id);
      await projects.addProjectMember(ctx(owner.id), guideline.id, {
        email: user.email,
        roles: ["REVIEWER"],
      });
    }
    await quotas.saveQuotas(
      ctx(owner.id),
      picos[0]!.id,
      { stageId: stage.id },
      {
        reviewers: users.map((user) => ({ reviewerId: user.id, target: null })),
      },
    );
    await quotas.saveQuotas(
      ctx(owner.id),
      guideline.id,
      { poolId: pool.id },
      {
        reviewers: users.map((user) => ({ reviewerId: user.id, target: null })),
      },
    );
    const ordinary: Awaited<ReturnType<typeof createTestCitation>>[] = [];
    for (let i = 0; i < 4; i++)
      ordinary.push(await createTestCitation(picos[0]!.id));
    for (const citation of ordinary.slice(0, 3))
      await screening.createDecision(
        ctx(users[0]!.id),
        picos[0]!.id,
        stage.id,
        {
          citationId: citation.id,
          decision: "INCLUDE",
        },
      );
    const navigator = await screening.getScreeningNavigator(
      ctx(users[0]!.id),
      picos[0]!.id,
      stage.id,
      screening.screeningNavigatorQuerySchema.parse({}),
    );
    expect(navigator.quota).toEqual({
      target: null,
      completed: 3,
      remaining: null,
    });
    expect(
      navigator.items.some(
        (item) => item.citation.id === ordinary[3]!.id && item.canDecide,
      ),
    ).toBe(true);
    await screening.createDecision(ctx(users[1]!.id), picos[0]!.id, stage.id, {
      citationId: ordinary[0]!.id,
      decision: "MAYBE",
    });
    await expect(
      screening.createDecision(ctx(users[2]!.id), picos[0]!.id, stage.id, {
        citationId: ordinary[0]!.id,
        decision: "INCLUDE",
      }),
    ).rejects.toMatchObject({ code: "INVALID_STATE" });

    const groups: string[][] = [];
    for (let i = 0; i < 3; i++) {
      const ids = [];
      const doi = `10.999/${uniq("pooled")}-${i}`;
      for (const project of picos.slice(1))
        ids.push(
          (
            await createTestCitation(project.id, {
              doi,
              title: `Shared abstract ${guideline.id} ${i}`,
            })
          ).id,
        );
      groups.push(ids);
    }
    for (const citationIds of groups)
      await pooled.createPooledDecision(ctx(users[0]!.id), guideline.id, {
        poolId: pool.id,
        citationIds,
        decision: "INCLUDE",
        notes: "Private review note",
      });
    expect(
      await quotas.quotaProgress(prisma, { poolId: pool.id }, users[0]!.id),
    ).toEqual({ target: null, completed: 3, remaining: null });
    await pooled.createPooledDecision(ctx(users[1]!.id), guideline.id, {
      poolId: pool.id,
      citationIds: groups[0]!,
      decision: "MAYBE",
    });
    await expect(
      pooled.createPooledDecision(ctx(users[2]!.id), guideline.id, {
        poolId: pool.id,
        citationIds: groups[0]!,
        decision: "INCLUDE",
      }),
    ).rejects.toMatchObject({ code: "INVALID_STATE" });
    const queue = await pooled.getPooledQueue(ctx(users[2]!.id), guideline.id, {
      poolId: pool.id,
    });
    expect(queue.items).toHaveLength(2);
    expect(JSON.stringify(queue)).not.toContain("Private review note");
    expect(JSON.stringify(queue)).not.toContain(users[0]!.id);
    expect(
      await prisma.screeningDecision.count({
        where: { citationId: { in: groups[0]! } },
      }),
    ).toBe(10);
    await quotas.saveQuotas(
      ctx(owner.id),
      guideline.id,
      { poolId: pool.id },
      { reviewers: [{ reviewerId: users[0]!.id, target: 0 }] },
    );
    expect(
      await quotas.quotaProgress(prisma, { poolId: pool.id }, users[0]!.id),
    ).toEqual({ target: 0, completed: 3, remaining: 0 });
  });

  it("rejects grants outside the organization or allowed scopes, and rolls back acceptance if the authorizer lost access", async () => {
    const { owner, org, guideline, stage } = await family();
    const user = await createTestUser();
    const invitation = await orgs.createOrganizationInvitation(
      ctx(owner.id),
      org.id,
      { email: user.email, role: "MEMBER" },
    );
    const other = await createTestOrg(owner.id);
    const otherProject = await projects.createProject(ctx(owner.id), other.id, {
      title: "Unrelated project",
      reviewType: "SYSTEMATIC_REVIEW",
    });
    await expect(
      orgs.configureOrganizationInvitationProjectAccess(
        ctx(owner.id),
        org.id,
        invitation.id,
        [
          {
            projectId: otherProject.id,
            roles: ["REVIEWER"],
          },
        ],
      ),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    const foreignStage = await prisma.screeningStage.findUniqueOrThrow({
      where: {
        projectId_type: { projectId: otherProject.id, type: "TITLE_ABSTRACT" },
      },
    });
    await expect(
      orgs.configureOrganizationInvitationProjectAccess(
        ctx(owner.id),
        org.id,
        invitation.id,
        [
          {
            projectId: guideline.id,
            roles: ["REVIEWER"],
            quotas: [{ stageId: foreignStage.id, target: 250 }],
          },
        ],
      ),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    await orgs.configureOrganizationInvitationProjectAccess(
      ctx(owner.id),
      org.id,
      invitation.id,
      [
        {
          projectId: guideline.id,
          roles: ["REVIEWER"],
          quotas: [{ stageId: stage.id, target: 250 }],
        },
      ],
    );
    await prisma.projectMember.update({
      where: {
        projectId_userId: { projectId: guideline.id, userId: owner.id },
      },
      data: { status: "REMOVED" },
    });
    await expect(
      orgs.acceptOrganizationInvitation(ctx(user.id), invitation.token),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(
      (
        await prisma.organizationInvitation.findUniqueOrThrow({
          where: { id: invitation.id },
        })
      ).acceptedAt,
    ).toBeNull();
    expect(
      await prisma.organizationMember.count({
        where: { orgId: org.id, userId: user.id },
      }),
    ).toBe(0);
    expect(
      await prisma.projectMember.count({ where: { userId: user.id } }),
    ).toBe(0);
    expect(
      await prisma.screeningQuota.count({ where: { reviewerId: user.id } }),
    ).toBe(0);
  });

  it("applies configured workspace grants when joining through a project invitation and preserves existing admin roles", async () => {
    const { owner, org, guideline, picos, stage, pool } = await family();
    const user = await createTestUser();
    const workspaceInvite = await orgs.createOrganizationInvitation(
      ctx(owner.id),
      org.id,
      { email: user.email, role: "MEMBER" },
    );
    await orgs.configureOrganizationInvitationProjectAccess(
      ctx(owner.id),
      org.id,
      workspaceInvite.id,
      [
        {
          projectId: guideline.id,
          roles: ["REVIEWER"],
          quotas: [
            { stageId: stage.id, target: null },
            { poolId: pool.id, target: null },
          ],
        },
      ],
    );
    await addOrgMember(org.id, user.id, "ADMIN");
    await projects.addProjectMember(ctx(owner.id), guideline.id, {
      email: user.email,
      roles: ["ADMIN"],
    });
    await quotas.saveQuotas(
      ctx(owner.id),
      guideline.id,
      { poolId: pool.id },
      { reviewers: [{ reviewerId: user.id, target: 200 }] },
    );
    const projectInvite = await projects.createInvitation(
      ctx(owner.id),
      guideline.id,
      { email: user.email, roles: ["REVIEWER"] },
    );
    await projects.acceptInvitation(ctx(user.id), projectInvite.token);
    expect(
      (
        await prisma.organizationInvitation.findUniqueOrThrow({
          where: { id: workspaceInvite.id },
        })
      ).acceptedAt,
    ).not.toBeNull();
    expect(
      (
        await prisma.organizationMember.findUniqueOrThrow({
          where: { orgId_userId: { orgId: org.id, userId: user.id } },
        })
      ).role,
    ).toBe("ADMIN");
    for (const project of [guideline, ...picos]) {
      expect(
        (await projects.getProject(ctx(user.id), project.id)).myRoles,
      ).toEqual(expect.arrayContaining(["ADMIN", "REVIEWER"]));
    }
    expect(
      await quotas.quotaProgress(prisma, { poolId: pool.id }, user.id),
    ).toEqual({ target: null, completed: 0, remaining: null });
  });
});
