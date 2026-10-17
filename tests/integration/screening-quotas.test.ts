import { beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/server/db";
import * as screening from "@/server/services/screening";
import * as quotas from "@/server/services/screening/quotas";
import * as pooled from "@/server/services/screening/pooled";
import { addCitationAbstract } from "@/server/services/citations";
import * as projects from "@/server/services/projects";
import { resetDb } from "../db-utils";
import {
  createProjectWithTeam,
  createTestCitation,
  addProjectMember,
} from "../factories";

const ctx = (userId: string) => ({ userId });
const query = screening.screeningNavigatorQuerySchema.parse({});
async function setup(target = 2) {
  const team = await createProjectWithTeam();
  const stage = (await screening.ensureStages(team.project.id)).find(
    (s) => s.type === "TITLE_ABSTRACT",
  )!;
  const citations = await Promise.all(
    [1, 2, 3].map(() => createTestCitation(team.project.id)),
  );
  await quotas.saveQuotas(
    ctx(team.owner.id),
    team.project.id,
    { stageId: stage.id },
    {
      reviewers: [team.reviewer1, team.reviewer2, team.owner].map((u) => ({
        reviewerId: u.id,
        target,
      })),
    },
  );
  return { ...team, stage, citations };
}

describe("shared abstract reviewer quotas", () => {
  beforeAll(resetDb);

  it("offers any abstract without preassigning records, counts once, and requires opt-in beyond the target", async () => {
    const { project, stage, reviewer1, citations } = await setup(1);
    const scope = { stageId: stage.id };
    const me = ctx(reviewer1.id);
    expect(
      await prisma.screeningAssignment.count({ where: { stageId: stage.id } }),
    ).toBe(0);
    const before = await screening.getScreeningNavigator(
      me,
      project.id,
      stage.id,
      query,
    );
    expect(before.items).toHaveLength(3);
    expect(before.quota).toEqual({ target: 1, completed: 0, remaining: 1 });
    const chosen = citations[2]!;
    await screening.createDecision(me, project.id, stage.id, {
      citationId: chosen.id,
      decision: "INCLUDE",
    });
    await screening.createDecision(me, project.id, stage.id, {
      citationId: chosen.id,
      decision: "EXCLUDE",
      notes: "Updated",
    });
    expect(await quotas.quotaProgress(prisma, scope, reviewer1.id)).toEqual({
      target: 1,
      completed: 1,
      remaining: 0,
    });
    expect((await screening.getQueue(me, project.id, stage.id)).total).toBe(2);
    await expect(
      screening.createDecision(me, project.id, stage.id, {
        citationId: citations[0]!.id,
        decision: "INCLUDE",
      }),
    ).rejects.toMatchObject({ code: "INVALID_STATE" });
    const history = await screening.getScreeningNavigator(
      me,
      project.id,
      stage.id,
      { ...query, status: "DECIDED" },
    );
    expect(history.items[0]?.myDecision).toEqual({
      decision: "EXCLUDE",
      notes: "Updated",
    });
  });

  it("continues beyond a positive target without changing targets or counting duplicate submissions", async () => {
    const { project, stage, reviewer1, citations } = await setup(1);
    const me = ctx(reviewer1.id);
    const decide = (citationId: string, continueBeyondQuota = false) =>
      screening.createDecision(me, project.id, stage.id, {
        citationId,
        decision: "INCLUDE",
        continueBeyondQuota,
      });
    await decide(citations[0]!.id);
    await expect(decide(citations[1]!.id)).rejects.toMatchObject({
      code: "INVALID_STATE",
    });
    await prisma.citation.update({
      where: { id: citations[1]!.id },
      data: { abstract: "" },
    });
    await addCitationAbstract(me, project.id, citations[1]!.id, {
      abstract: "Recovered after reaching the target",
    });
    await Promise.all([
      decide(citations[1]!.id, true),
      decide(citations[1]!.id, true),
    ]);
    expect(
      await quotas.quotaProgress(prisma, { stageId: stage.id }, reviewer1.id),
    ).toEqual({ target: 1, completed: 2, remaining: 0 });
    expect(
      await prisma.screeningDecision.count({ where: { stageId: stage.id } }),
    ).toBe(2);
    expect(
      await prisma.auditEvent.count({
        where: { projectId: project.id, action: "screening.quota.updated" },
      }),
    ).toBe(3);
    await decide(citations[2]!.id, true);
    const empty = await screening.getScreeningNavigator(
      me,
      project.id,
      stage.id,
      query,
    );
    expect(empty.summary.undecided).toBe(0);
    expect(empty.quota).toEqual({ target: 1, completed: 3, remaining: 0 });
  });

  it("keeps two independent reviewers under concurrent opted-in submissions after each target is reached", async () => {
    const { project, stage, reviewer1, reviewer2, owner, citations } =
      await setup(1);
    const reviewers = [reviewer1, reviewer2, owner];
    for (let i = 0; i < reviewers.length; i++) {
      await screening.createDecision(
        ctx(reviewers[i]!.id),
        project.id,
        stage.id,
        {
          citationId: citations[i]!.id,
          decision: "INCLUDE",
        },
      );
    }
    const shared = await createTestCitation(project.id);
    const results = await Promise.allSettled(
      reviewers.map((user) =>
        screening.createDecision(ctx(user.id), project.id, stage.id, {
          citationId: shared.id,
          decision: "MAYBE",
          continueBeyondQuota: true,
        }),
      ),
    );
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(2);
    const votes = await prisma.screeningDecision.findMany({
      where: { citationId: shared.id },
    });
    expect(new Set(votes.map((v) => v.reviewerId)).size).toBe(2);
    for (const vote of votes) {
      expect(
        await quotas.quotaProgress(
          prisma,
          { stageId: stage.id },
          vote.reviewerId,
        ),
      ).toEqual({ target: 1, completed: 2, remaining: 0 });
    }
  });

  it("allows an opted-in batch beyond target and retains atomic rollback on a stale article", async () => {
    const { project, stage, reviewer1, reviewer2, owner, citations } =
      await setup(1);
    const reason = await prisma.exclusionReason.create({
      data: {
        projectId: project.id,
        label: "Outside scope",
        stage: "TITLE_ABSTRACT",
      },
    });
    await screening.createDecision(ctx(reviewer1.id), project.id, stage.id, {
      citationId: citations[0]!.id,
      decision: "INCLUDE",
    });
    const batch = {
      citationIds: citations.slice(1).map((c) => c.id),
      exclusionReasonId: reason.id,
      continueBeyondQuota: true,
    };
    await screening.batchExclude(
      ctx(reviewer1.id),
      project.id,
      stage.id,
      batch,
    );
    expect(
      await quotas.quotaProgress(prisma, { stageId: stage.id }, reviewer1.id),
    ).toEqual({ target: 1, completed: 3, remaining: 0 });
    await screening.createDecision(ctx(reviewer2.id), project.id, stage.id, {
      citationId: citations[2]!.id,
      decision: "INCLUDE",
    });
    const fresh = await createTestCitation(project.id);
    await expect(
      screening.batchExclude(ctx(owner.id), project.id, stage.id, {
        ...batch,
        citationIds: [fresh.id, citations[2]!.id],
      }),
    ).rejects.toMatchObject({ code: "INVALID_STATE" });
    expect(
      await prisma.screeningDecision.count({ where: { citationId: fresh.id } }),
    ).toBe(0);
  });

  it("does not turn continuation into an assignment or override a zero-target pause or removed membership", async () => {
    const { project, stage, reviewer1, reviewer2, owner, org, citations } =
      await setup(0);
    const input = {
      citationId: citations[0]!.id,
      decision: "INCLUDE" as const,
      continueBeyondQuota: true,
    };
    await expect(
      screening.createDecision(ctx(reviewer1.id), project.id, stage.id, input),
    ).rejects.toMatchObject({ code: "INVALID_STATE" });
    await prisma.screeningQuota.deleteMany({
      where: { stageId: stage.id, reviewerId: reviewer2.id },
    });
    await expect(
      screening.createDecision(ctx(reviewer2.id), project.id, stage.id, input),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    await quotas.saveQuotas(
      ctx(owner.id),
      project.id,
      { stageId: stage.id },
      { reviewers: [{ reviewerId: reviewer1.id, target: 1 }] },
    );
    await prisma.organizationMember.update({
      where: { orgId_userId: { orgId: org.id, userId: reviewer1.id } },
      data: { status: "REMOVED" },
    });
    await expect(
      screening.createDecision(ctx(reviewer1.id), project.id, stage.id, input),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(
      await prisma.screeningDecision.count({ where: { stageId: stage.id } }),
    ).toBe(0);
  });

  it("removes a conflicted abstract for everyone else and rejects stale third reviews", async () => {
    const { project, stage, reviewer1, reviewer2, owner, citations } =
      await setup();
    const citationId = citations[0]!.id;
    await screening.createDecision(ctx(reviewer1.id), project.id, stage.id, {
      citationId,
      decision: "INCLUDE",
    });
    await screening.createDecision(ctx(reviewer2.id), project.id, stage.id, {
      citationId,
      decision: "EXCLUDE",
    });
    expect(
      await prisma.screeningConflict.count({
        where: { citationId, status: "OPEN" },
      }),
    ).toBe(1);
    const remaining = await screening.getScreeningNavigator(
      ctx(owner.id),
      project.id,
      stage.id,
      query,
    );
    expect(remaining.items.map((i) => i.citation.id)).not.toContain(citationId);
    expect(remaining.quota).toEqual({ target: 2, completed: 0, remaining: 2 });
    await expect(
      screening.createDecision(ctx(owner.id), project.id, stage.id, {
        citationId,
        decision: "INCLUDE",
      }),
    ).rejects.toMatchObject({ code: "INVALID_STATE" });
    expect(
      await prisma.screeningDecision.count({ where: { citationId } }),
    ).toBe(2);
    expect(JSON.stringify(remaining)).not.toContain(reviewer1.id);
    expect(JSON.stringify(remaining)).not.toContain(reviewer2.id);
  });

  it("serializes three simultaneous reviews and concurrent requests for the last quota slot", async () => {
    const { project, stage, reviewer1, reviewer2, owner, citations } =
      await setup(1);
    const results = await Promise.allSettled(
      [reviewer1, reviewer2, owner].map((user) =>
        screening.createDecision(ctx(user.id), project.id, stage.id, {
          citationId: citations[0]!.id,
          decision: "INCLUDE",
        }),
      ),
    );
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(2);
    expect(
      await prisma.screeningDecision.count({
        where: { stageId: stage.id, citationId: citations[0]!.id },
      }),
    ).toBe(2);
    const loser = [reviewer1, reviewer2, owner][
      results.findIndex((r) => r.status === "rejected")
    ]!;
    const lastSlot = await Promise.allSettled(
      citations.slice(1).map((c) =>
        screening.createDecision(ctx(loser.id), project.id, stage.id, {
          citationId: c.id,
          decision: "INCLUDE",
        }),
      ),
    );
    expect(lastSlot.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(
      await quotas.quotaProgress(prisma, { stageId: stage.id }, loser.id),
    ).toEqual({ target: 1, completed: 1, remaining: 0 });
  });

  it("supports atomic batch exclusion, counts prior work, and allows audited target changes", async () => {
    const { project, stage, reviewer1, owner, citations } = await setup(1);
    const reason = await prisma.exclusionReason.create({
      data: {
        projectId: project.id,
        label: "Wrong population",
        stage: "TITLE_ABSTRACT",
      },
    });
    const input = {
      citationIds: citations.slice(0, 2).map((c) => c.id),
      exclusionReasonId: reason.id,
    };
    await expect(
      screening.batchExclude(ctx(reviewer1.id), project.id, stage.id, input),
    ).rejects.toMatchObject({ code: "INVALID_STATE" });
    expect(
      await prisma.screeningDecision.count({ where: { stageId: stage.id } }),
    ).toBe(0);
    await quotas.saveQuotas(
      ctx(owner.id),
      project.id,
      { stageId: stage.id },
      { reviewers: [{ reviewerId: reviewer1.id, target: 2 }] },
    );
    await screening.batchExclude(
      ctx(reviewer1.id),
      project.id,
      stage.id,
      input,
    );
    expect(
      await quotas.quotaProgress(prisma, { stageId: stage.id }, reviewer1.id),
    ).toEqual({ target: 2, completed: 2, remaining: 0 });
    const admin = await quotas.listQuotas(ctx(owner.id), project.id, {
      stageId: stage.id,
    });
    expect(
      admin.reviewers.find((r) => r.id === reviewer1.id)?.quota?.completed,
    ).toBe(2);
    expect(
      await prisma.auditEvent.count({
        where: { projectId: project.id, action: "screening.quota.updated" },
      }),
    ).toBe(4);
  });

  it("credits earlier fixed assignments and lets quota reviewers repair missing abstracts", async () => {
    const { project, reviewer1, owner } = await createProjectWithTeam();
    const stage = (await screening.ensureStages(project.id)).find(
      (s) => s.type === "TITLE_ABSTRACT",
    )!;
    const earlier = await createTestCitation(project.id);
    await screening.createAssignments(ctx(owner.id), project.id, stage.id, {
      reviewerIds: [reviewer1.id],
      strategy: "all",
    });
    await screening.createDecision(ctx(reviewer1.id), project.id, stage.id, {
      citationId: earlier.id,
      decision: "INCLUDE",
    });
    const addedLater = await createTestCitation(project.id, { abstract: "" });
    await quotas.saveQuotas(
      ctx(owner.id),
      project.id,
      { stageId: stage.id },
      { reviewers: [{ reviewerId: reviewer1.id, target: 2 }] },
    );
    expect(
      await quotas.quotaProgress(prisma, { stageId: stage.id }, reviewer1.id),
    ).toEqual({ target: 2, completed: 1, remaining: 1 });
    await addCitationAbstract(ctx(reviewer1.id), project.id, addedLater.id, {
      abstract: "Recovered abstract",
    });
    expect(
      (await screening.getQueue(ctx(reviewer1.id), project.id, stage.id))
        .items[0]?.citation.abstract,
    ).toBe("Recovered abstract");
    expect(
      (await screening.listStages(ctx(owner.id), project.id))[0]?.progress
        .assignedCitations,
    ).toBe(2);
    await screening.createDecision(ctx(reviewer1.id), project.id, stage.id, {
      citationId: addedLater.id,
      decision: "INCLUDE",
    });
    expect(
      await prisma.screeningAssignment.count({ where: { stageId: stage.id } }),
    ).toBe(2);
  });

  it("also closes fixed-assignment queues at two conflicting reviews", async () => {
    const { project, reviewer1, reviewer2, owner } =
      await createProjectWithTeam();
    const stage = (await screening.ensureStages(project.id)).find(
      (s) => s.type === "TITLE_ABSTRACT",
    )!;
    const citation = await createTestCitation(project.id);
    await screening.createAssignments(ctx(owner.id), project.id, stage.id, {
      reviewerIds: [owner.id, reviewer1.id, reviewer2.id],
      strategy: "all",
    });
    await screening.createDecision(ctx(reviewer1.id), project.id, stage.id, {
      citationId: citation.id,
      decision: "INCLUDE",
    });
    await screening.createDecision(ctx(reviewer2.id), project.id, stage.id, {
      citationId: citation.id,
      decision: "EXCLUDE",
    });
    expect(
      (await screening.getQueue(ctx(owner.id), project.id, stage.id)).items,
    ).toHaveLength(0);
    expect(
      (
        await screening.getScreeningNavigator(
          ctx(owner.id),
          project.id,
          stage.id,
          query,
        )
      ).items,
    ).toHaveLength(0);
    await expect(
      screening.createDecision(ctx(owner.id), project.id, stage.id, {
        citationId: citation.id,
        decision: "INCLUDE",
      }),
    ).rejects.toMatchObject({ code: "INVALID_STATE" });
  });

  it("enforces manager, tenant, membership, and dual-screening boundaries", async () => {
    const team = await setup();
    const { project, stage, owner, reviewer1 } = team;
    const input = { reviewers: [{ reviewerId: reviewer1.id, target: 3 }] };
    await expect(
      quotas.saveQuotas(
        ctx(reviewer1.id),
        project.id,
        { stageId: stage.id },
        input,
      ),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(
      quotas.listQuotas(ctx(reviewer1.id), project.id, { stageId: stage.id }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(
      quotas.saveQuotas(
        ctx(owner.id),
        project.id,
        { stageId: "foreign" },
        input,
      ),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(
      screening.updateStage(ctx(owner.id), project.id, stage.id, {
        reviewersPerCitation: 3,
      }),
    ).rejects.toMatchObject({ code: "INVALID_STATE" });
    await prisma.organizationMember.update({
      where: { orgId_userId: { orgId: team.org.id, userId: reviewer1.id } },
      data: { status: "REMOVED" },
    });
    await expect(
      quotas.saveQuotas(
        ctx(owner.id),
        project.id,
        { stageId: stage.id },
        input,
      ),
    ).rejects.toMatchObject({ code: "VALIDATION" });
    await expect(
      screening.getQueue(ctx(reviewer1.id), project.id, stage.id),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("counts a pooled abstract once, protects all linked copies, and does not leak votes", async () => {
    const team = await createProjectWithTeam();
    const { owner, reviewer1, reviewer2, org } = team;
    const guideline = await projects.createProject(ctx(owner.id), org.id, {
      title: "Quota guideline",
      reviewType: "GUIDELINE_EVIDENCE_REVIEW",
      isGuideline: true,
      reviewersPerCitation: 2,
    });
    for (const user of [reviewer1, reviewer2])
      await addProjectMember(guideline.id, user.id, ["REVIEWER"]);
    const pico1 = await projects.createSubProject(ctx(owner.id), guideline.id, {
      title: "One",
      researchQuestion: "Question one",
    });
    const pico2 = await projects.createSubProject(ctx(owner.id), guideline.id, {
      title: "Two",
      researchQuestion: "Question two",
    });
    const a = await createTestCitation(pico1.id, {
      title: "Shared abstract",
      doi: "10.1000/shared",
    });
    const b = await createTestCitation(pico2.id, {
      title: "Shared abstract",
      doi: "10.1000/shared",
    });
    await createTestCitation(pico1.id);
    const pool = await pooled.saveGuidelineScreeningPool(
      ctx(owner.id),
      guideline.id,
      { name: "Shared quota pool", projectIds: [pico1.id, pico2.id] },
    );
    await quotas.saveQuotas(
      ctx(owner.id),
      guideline.id,
      { poolId: pool.id },
      {
        reviewers: [owner, reviewer1, reviewer2].map((user) => ({
          reviewerId: user.id,
          target: 1,
        })),
      },
    );
    const before = await pooled.getPooledQueue(
      ctx(reviewer1.id),
      guideline.id,
      { poolId: pool.id },
    );
    expect(before.total).toBe(2);
    const decision = {
      poolId: pool.id,
      citationIds: [a.id, b.id],
      decision: "INCLUDE" as const,
    };
    const results = await Promise.allSettled(
      [reviewer1, reviewer2, owner].map((user) =>
        pooled.createPooledDecision(ctx(user.id), guideline.id, decision),
      ),
    );
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(2);
    expect(
      await prisma.screeningDecision.count({
        where: { citationId: { in: [a.id, b.id] } },
      }),
    ).toBe(4);
    const winner = [reviewer1, reviewer2, owner][
      results.findIndex((r) => r.status === "fulfilled")
    ]!;
    const after = await pooled.getPooledQueue(ctx(winner.id), guideline.id, {
      poolId: pool.id,
    });
    expect(after.quota).toEqual({ target: 1, completed: 1, remaining: 0 });
    expect(after.total).toBe(1);
    const loser = [reviewer1, reviewer2, owner][
      results.findIndex((r) => r.status === "rejected")
    ]!;
    const remaining = await pooled.getPooledQueue(ctx(loser.id), guideline.id, {
      poolId: pool.id,
    });
    expect(remaining.total).toBe(1);
    expect(remaining.items[0]?.citationIds).not.toContain(a.id);
    expect(JSON.stringify(remaining)).not.toContain(winner.id);
    // The last abstract also leaves the pool when the two reviews disagree.
    const outstanding = remaining.items[0]!;
    await expect(
      pooled.createPooledDecision(ctx(winner.id), guideline.id, {
        poolId: pool.id,
        citationIds: outstanding.citationIds,
        decision: "INCLUDE",
      }),
    ).rejects.toMatchObject({ code: "INVALID_STATE" });
    await pooled.createPooledDecision(ctx(reviewer1.id), guideline.id, {
      poolId: pool.id,
      citationIds: outstanding.citationIds,
      continueBeyondQuota: true,
      decision: "INCLUDE",
    });
    await pooled.createPooledDecision(ctx(reviewer2.id), guideline.id, {
      poolId: pool.id,
      citationIds: outstanding.citationIds,
      continueBeyondQuota: true,
      decision: "EXCLUDE",
      exclusionReasonLabel: remaining.reasons[0]!.label,
    });
    expect(
      (
        await pooled.getPooledQueue(ctx(owner.id), guideline.id, {
          poolId: pool.id,
        })
      ).total,
    ).toBe(0);
    await expect(
      pooled.createPooledDecision(ctx(owner.id), guideline.id, {
        poolId: pool.id,
        citationIds: outstanding.citationIds,
        continueBeyondQuota: true,
        decision: "INCLUDE",
      }),
    ).rejects.toMatchObject({ code: "INVALID_STATE" });
    expect(
      (
        await pooled.getPooledQueue(ctx(winner.id), guideline.id, {
          poolId: pool.id,
        })
      ).quota,
    ).toEqual({
      target: 1,
      completed: winner.id === owner.id ? 1 : 2,
      remaining: 0,
    });
    const replacementPicos = [];
    for (const title of ["Replacement one", "Replacement two"]) {
      const pico = await projects.createSubProject(
        ctx(owner.id),
        guideline.id,
        { title, researchQuestion: title },
      );
      const stage = (await screening.ensureStages(pico.id)).find(
        (s) => s.type === "TITLE_ABSTRACT",
      )!;
      await screening.updateStage(ctx(owner.id), pico.id, stage.id, {
        reviewersPerCitation: 3,
      });
      replacementPicos.push(pico.id);
    }
    await expect(
      pooled.saveGuidelineScreeningPool(ctx(owner.id), guideline.id, {
        name: "Invalid three-reviewer pool",
        projectIds: replacementPicos,
      }),
    ).rejects.toMatchObject({ code: "INVALID_STATE" });
  });
});
