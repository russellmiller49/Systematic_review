// AI prescreening integration tests — full run lifecycle against the FakeAiProvider,
// eligibility filtering, latest-wins re-runs, failure paths, poll idempotence, queue
// ranking/visibility gates, permissions, and the R1 decision (run audit events are
// non-sensitive and visible to plain audit.view holders).
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/server/db";
import { AppError } from "@/server/errors";
import * as aiScreening from "@/server/services/ai-screening";
import * as screening from "@/server/services/screening";
import { listAuditEvents } from "@/server/services/audit-query";
import { resetAiProviderForTests, setAiProviderForTests } from "@/server/ai/provider";
import { SCREENING_PROMPT_VERSION } from "@/server/ai/prompts/screening";
import { FakeAiProvider } from "../fake-ai-provider";
import { resetDb } from "../db-utils";
import { createProjectWithTeam, createTestCitation } from "../factories";

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

async function setup(options: { protocol?: boolean } = {}) {
  const team = await createProjectWithTeam();
  if (options.protocol !== false) {
    await prisma.protocol.create({
      data: {
        projectId: team.project.id,
        reviewQuestion: "Does drug X improve outcome Y in adults?",
        population: "Adults",
        criteria: {
          create: [
            { type: "INCLUSION", text: "Adults 18 or older", order: 0 },
            { type: "EXCLUSION", text: "Animal studies", order: 0 },
          ],
        },
      },
    });
  }
  const stage = await prisma.screeningStage.create({
    data: { projectId: team.project.id, type: "TITLE_ABSTRACT" },
  });
  return { ...team, stage };
}

let fake: FakeAiProvider;

beforeAll(async () => {
  await resetDb();
});

beforeEach(() => {
  fake = new FakeAiProvider();
  setAiProviderForTests(fake);
});

afterEach(() => {
  resetAiProviderForTests();
});

describe("ai prescreening runs", () => {
  it("runs the full lifecycle: start → poll(processing) → poll(ended) → suggestions", async () => {
    const { owner, reviewer1, project, stage } = await setup();
    const c1 = await createTestCitation(project.id, { title: "Trial of X in adults" });
    const c2 = await createTestCitation(project.id, { title: "Cohort of X in children" });
    const settled = await createTestCitation(project.id, { title: "Already settled" });
    await prisma.citationStageResult.create({
      data: { stageId: stage.id, citationId: settled.id, outcome: "EXCLUDE", resolvedVia: "CONSENSUS" },
    });

    const run = await aiScreening.startPrescreenRun(ctx(owner.id), project.id, stage.id, {});
    expect(run.status).toBe("SUBMITTED");
    expect(run.totalCount).toBe(2);
    expect(run.providerBatchId).toBe("fake-batch-1");
    expect(run.model).toBe("claude-opus-4-8"); // provider default (no env override in tests)
    expect(run.promptVersion).toBe(SCREENING_PROMPT_VERSION);
    expect("requestKeys" in run).toBe(false); // never shipped to clients
    expect(fake.createdBatches[0]!.items.map((i) => i.customId)).toEqual([c1.id, c2.id]);
    // The prompt carries the protocol criteria and the citation.
    expect(fake.createdBatches[0]!.items[0]!.prompt.user).toContain("Adults 18 or older");
    expect(fake.createdBatches[0]!.items[0]!.prompt.user).toContain("Trial of X in adults");

    // Still processing → run unchanged, no suggestions.
    let polled = await aiScreening.pollPrescreenRun(ctx(owner.id), project.id, run.id);
    expect(polled.status).toBe("SUBMITTED");
    expect(fake.polls[0]!.customIds).toEqual([c1.id, c2.id]);
    expect(await prisma.screeningSuggestion.count({ where: { stageId: stage.id } })).toBe(0);

    fake.endBatchWith([
      {
        customId: c1.id,
        ok: true,
        json: { score: 150, decision: "INCLUDE", rationale: "Matches all criteria" },
        usage: { inputTokens: 500, outputTokens: 40 },
      },
      {
        customId: c2.id,
        ok: true,
        json: { score: 61.7, decision: "MAYBE", rationale: "Population unclear" },
        usage: { inputTokens: 480, outputTokens: 35 },
      },
    ]);
    polled = await aiScreening.pollPrescreenRun(ctx(owner.id), project.id, run.id);
    expect(polled.status).toBe("COMPLETED");
    expect(polled.succeededCount).toBe(2);
    expect(polled.failedCount).toBe(0);
    expect(polled.usage).toEqual({ inputTokens: 980, outputTokens: 75 });

    const s1 = await prisma.screeningSuggestion.findUnique({
      where: { stageId_citationId: { stageId: stage.id, citationId: c1.id } },
    });
    expect(s1).toMatchObject({
      score: 100, // clamped from 150
      suggestedDecision: "INCLUDE",
      rationale: "Matches all criteria",
      runId: run.id,
      provider: "anthropic",
      promptVersion: SCREENING_PROMPT_VERSION,
    });
    const s2 = await prisma.screeningSuggestion.findUnique({
      where: { stageId_citationId: { stageId: stage.id, citationId: c2.id } },
    });
    expect(s2?.score).toBe(62); // rounded

    // Poll after terminal state is a no-op (no extra provider call, nothing changes).
    const again = await aiScreening.pollPrescreenRun(ctx(owner.id), project.id, run.id);
    expect(again.status).toBe("COMPLETED");
    expect(fake.polls).toHaveLength(2);

    // R1 decision: run events are non-sensitive — a plain reviewer (audit.view, not an
    // adjudicator, not the actor) sees ai.prescreen.* rows.
    const page = await listAuditEvents(ctx(reviewer1.id), project.id, {
      actionPrefix: "ai.prescreen",
    });
    expect(page.events.map((e) => e.action).sort()).toEqual([
      "ai.prescreen.completed",
      "ai.prescreen.started",
    ]);
  });

  it("skips settled, duplicate, empty-title, and already-suggested citations", async () => {
    const { owner, project, stage } = await setup();
    const eligible = await createTestCitation(project.id);
    const duplicate = await createTestCitation(project.id);
    await prisma.citation.update({ where: { id: duplicate.id }, data: { status: "DUPLICATE" } });
    await prisma.citation.create({
      data: { projectId: project.id, title: "", normalizedTitle: "", authors: [] },
    });
    const settled = await createTestCitation(project.id);
    await prisma.citationStageResult.create({
      data: { stageId: stage.id, citationId: settled.id, outcome: "INCLUDE", resolvedVia: "CONSENSUS" },
    });
    const suggested = await createTestCitation(project.id);
    const priorRun = await prisma.aiScreeningRun.create({
      data: {
        projectId: project.id,
        stageId: stage.id,
        status: "COMPLETED",
        provider: "anthropic",
        model: "claude-opus-4-8",
        promptVersion: SCREENING_PROMPT_VERSION,
        requestedById: owner.id,
      },
    });
    await prisma.screeningSuggestion.create({
      data: {
        stageId: stage.id,
        citationId: suggested.id,
        runId: priorRun.id,
        score: 55,
        suggestedDecision: "MAYBE",
        rationale: "prior",
        provider: "anthropic",
        model: "claude-opus-4-8",
        promptVersion: SCREENING_PROMPT_VERSION,
      },
    });

    const run = await aiScreening.startPrescreenRun(ctx(owner.id), project.id, stage.id, {});
    expect(run.totalCount).toBe(1);
    expect(fake.createdBatches[0]!.items[0]!.customId).toBe(eligible.id);

    const listed = await aiScreening.listRuns(ctx(owner.id), project.id, stage.id);
    expect(listed.eligible).toEqual({ unscored: 1, unsettled: 2 });
    expect(listed.runs.map((r) => r.id)).toContain(run.id);

    // rescoreExisting includes the already-suggested citation.
    await aiScreening.cancelRun(ctx(owner.id), project.id, run.id);
    const rescore = await aiScreening.startPrescreenRun(ctx(owner.id), project.id, stage.id, {
      rescoreExisting: true,
    });
    expect(rescore.totalCount).toBe(2);
    expect(fake.createdBatches[1]!.items.map((i) => i.customId).sort()).toEqual(
      [eligible.id, suggested.id].sort(),
    );
  });

  it("re-runs overwrite suggestions latest-wins", async () => {
    const { owner, project, stage } = await setup();
    const citation = await createTestCitation(project.id);

    const first = await aiScreening.startPrescreenRun(ctx(owner.id), project.id, stage.id, {});
    fake.endBatchScoringAll(20, "EXCLUDE");
    await aiScreening.pollPrescreenRun(ctx(owner.id), project.id, first.id);

    const second = await aiScreening.startPrescreenRun(ctx(owner.id), project.id, stage.id, {
      rescoreExisting: true,
    });
    fake.endBatchScoringAll(85, "INCLUDE");
    await aiScreening.pollPrescreenRun(ctx(owner.id), project.id, second.id);

    const suggestions = await prisma.screeningSuggestion.findMany({
      where: { stageId: stage.id, citationId: citation.id },
    });
    expect(suggestions).toHaveLength(1);
    expect(suggestions[0]).toMatchObject({ score: 85, suggestedDecision: "INCLUDE", runId: second.id });
  });

  it("marks the run FAILED and audits when the provider rejects the batch", async () => {
    const { owner, project, stage } = await setup();
    await createTestCitation(project.id);
    fake.failSubmit = "quota exceeded";

    await expectAppError(
      aiScreening.startPrescreenRun(ctx(owner.id), project.id, stage.id, {}),
      "INVALID_STATE",
    );
    const run = await prisma.aiScreeningRun.findFirst({ where: { stageId: stage.id } });
    expect(run?.status).toBe("FAILED");
    expect(run?.error).toContain("quota exceeded");
    expect(
      await prisma.auditEvent.count({
        where: { projectId: project.id, action: "ai.prescreen.failed" },
      }),
    ).toBe(1);

    // A FAILED run does not block a new start.
    fake.failSubmit = null;
    const retry = await aiScreening.startPrescreenRun(ctx(owner.id), project.id, stage.id, {});
    expect(retry.status).toBe("SUBMITTED");
  });

  it("counts per-item failures and the next run picks exactly the unscored citations", async () => {
    const { owner, project, stage } = await setup();
    const ok = await createTestCitation(project.id);
    const errored = await createTestCitation(project.id);
    const badShape = await createTestCitation(project.id);

    const run = await aiScreening.startPrescreenRun(ctx(owner.id), project.id, stage.id, {});
    fake.endBatchWith([
      {
        customId: ok.id,
        ok: true,
        json: { score: 80, decision: "INCLUDE", rationale: "ok" },
      },
      { customId: errored.id, ok: false, error: "provider exploded" },
      { customId: badShape.id, ok: true, json: { score: "high", decision: "YES" } },
    ]);
    const polled = await aiScreening.pollPrescreenRun(ctx(owner.id), project.id, run.id);
    expect(polled.status).toBe("COMPLETED");
    expect(polled.succeededCount).toBe(1);
    expect(polled.failedCount).toBe(2);
    expect(await prisma.screeningSuggestion.count({ where: { stageId: stage.id } })).toBe(1);

    const retry = await aiScreening.startPrescreenRun(ctx(owner.id), project.id, stage.id, {});
    expect(retry.totalCount).toBe(2);
    expect(fake.createdBatches[1]!.items.map((i) => i.customId).sort()).toEqual(
      [errored.id, badShape.id].sort(),
    );
  });

  it("rejects a second start while a run is in flight; cancel unblocks", async () => {
    const { owner, project, stage } = await setup();
    await createTestCitation(project.id);
    const run = await aiScreening.startPrescreenRun(ctx(owner.id), project.id, stage.id, {});
    await expectAppError(
      aiScreening.startPrescreenRun(ctx(owner.id), project.id, stage.id, { rescoreExisting: true }),
      "INVALID_STATE",
    );
    const canceled = await aiScreening.cancelRun(ctx(owner.id), project.id, run.id);
    expect(canceled.status).toBe("CANCELED");
    expect(fake.canceledBatchIds).toEqual(["fake-batch-1"]);
    const next = await aiScreening.startPrescreenRun(ctx(owner.id), project.id, stage.id, {
      rescoreExisting: true,
    });
    expect(next.status).toBe("SUBMITTED");
  });

  it("guards: stage type, missing protocol, empty protocol, disabled provider, no citations", async () => {
    const { owner, project, stage } = await setup({ protocol: false });
    const ftStage = await prisma.screeningStage.create({
      data: { projectId: project.id, type: "FULL_TEXT" },
    });
    await createTestCitation(project.id);

    await expectAppError(
      aiScreening.startPrescreenRun(ctx(owner.id), project.id, ftStage.id, {}),
      "INVALID_STATE",
    );
    // No protocol at all.
    await expectAppError(
      aiScreening.startPrescreenRun(ctx(owner.id), project.id, stage.id, {}),
      "INVALID_STATE",
    );
    // Protocol without any criteria / PICO / review question.
    await prisma.protocol.create({ data: { projectId: project.id } });
    await expectAppError(
      aiScreening.startPrescreenRun(ctx(owner.id), project.id, stage.id, {}),
      "INVALID_STATE",
    );
    // Disabled provider.
    await prisma.protocol.update({
      where: { projectId: project.id },
      data: { reviewQuestion: "Q?" },
    });
    setAiProviderForTests(null);
    await expectAppError(
      aiScreening.startPrescreenRun(ctx(owner.id), project.id, stage.id, {}),
      "INVALID_STATE",
    );
    // Re-enable, settle the only citation → nothing eligible.
    setAiProviderForTests(fake);
    const only = await prisma.citation.findFirst({ where: { projectId: project.id } });
    await prisma.citationStageResult.create({
      data: { stageId: stage.id, citationId: only!.id, outcome: "EXCLUDE", resolvedVia: "CONSENSUS" },
    });
    await expectAppError(
      aiScreening.startPrescreenRun(ctx(owner.id), project.id, stage.id, {}),
      "INVALID_STATE",
    );
  });

  it("denies reviewers every run operation (screening.configure required)", async () => {
    const { owner, reviewer1, project, stage } = await setup();
    await createTestCitation(project.id);
    const run = await aiScreening.startPrescreenRun(ctx(owner.id), project.id, stage.id, {});

    await expectAppError(
      aiScreening.startPrescreenRun(ctx(reviewer1.id), project.id, stage.id, {}),
      "FORBIDDEN",
    );
    await expectAppError(
      aiScreening.pollPrescreenRun(ctx(reviewer1.id), project.id, run.id),
      "FORBIDDEN",
    );
    await expectAppError(aiScreening.listRuns(ctx(reviewer1.id), project.id, stage.id), "FORBIDDEN");
    await expectAppError(aiScreening.getRun(ctx(reviewer1.id), project.id, run.id), "FORBIDDEN");
    await expectAppError(aiScreening.cancelRun(ctx(reviewer1.id), project.id, run.id), "FORBIDDEN");
  });
});

describe("queue ranking and score visibility", () => {
  it("orders by score desc with unscored last, and aiShowScores gates the payload", async () => {
    const { owner, reviewer1, project, stage } = await setup();
    const low = await createTestCitation(project.id, { title: "Low score citation" });
    const high = await createTestCitation(project.id, { title: "High score citation" });
    const unscored = await createTestCitation(project.id, { title: "Unscored citation" });

    await screening.createAssignments(ctx(owner.id), project.id, stage.id, {
      reviewerIds: [reviewer1.id],
      strategy: "all",
    });

    const run = await prisma.aiScreeningRun.create({
      data: {
        projectId: project.id,
        stageId: stage.id,
        status: "COMPLETED",
        provider: "anthropic",
        model: "claude-opus-4-8",
        promptVersion: SCREENING_PROMPT_VERSION,
        requestedById: owner.id,
      },
    });
    await prisma.screeningSuggestion.createMany({
      data: [
        { citationId: low.id, score: 10, suggestedDecision: "EXCLUDE" as const, rationale: "off-topic" },
        { citationId: high.id, score: 90, suggestedDecision: "INCLUDE" as const, rationale: "on-topic" },
      ].map((s) => ({
        ...s,
        stageId: stage.id,
        runId: run.id,
        provider: "anthropic",
        model: "claude-opus-4-8",
        promptVersion: SCREENING_PROMPT_VERSION,
      })),
    });

    // Default: FIFO order, scores visible (aiShowScores defaults true).
    let queue = await screening.getQueue(ctx(reviewer1.id), project.id, stage.id);
    expect(queue.items.map((i) => i.citation.id)).toEqual([low.id, high.id, unscored.id]);
    expect(queue.items[0]!.aiSuggestion).toEqual({
      score: 10,
      suggestedDecision: "EXCLUDE",
      rationale: "off-topic",
    });
    expect(queue.items[2]!.aiSuggestion).toBeNull();

    // Ranking on: high → low → unscored.
    await screening.updateStage(ctx(owner.id), project.id, stage.id, { aiRankingEnabled: true });
    queue = await screening.getQueue(ctx(reviewer1.id), project.id, stage.id);
    expect(queue.items.map((i) => i.citation.id)).toEqual([high.id, low.id, unscored.id]);
    expect(queue.total).toBe(3);

    // Hide scores: order still ranked, but no aiSuggestion in the payload.
    await screening.updateStage(ctx(owner.id), project.id, stage.id, { aiShowScores: false });
    queue = await screening.getQueue(ctx(reviewer1.id), project.id, stage.id);
    expect(queue.items.map((i) => i.citation.id)).toEqual([high.id, low.id, unscored.id]);
    expect(queue.items.every((i) => i.aiSuggestion === null)).toBe(true);

    // Ranking off again: back to FIFO.
    await screening.updateStage(ctx(owner.id), project.id, stage.id, { aiRankingEnabled: false });
    queue = await screening.getQueue(ctx(reviewer1.id), project.id, stage.id);
    expect(queue.items.map((i) => i.citation.id)).toEqual([low.id, high.id, unscored.id]);

    // The stage update audit captured the AI toggles.
    const stageEvents = await prisma.auditEvent.findMany({
      where: { projectId: project.id, action: "screening.stage.updated" },
      orderBy: { createdAt: "asc" },
    });
    expect(stageEvents.length).toBeGreaterThanOrEqual(3);
    const newValue = stageEvents[0]!.newValue as { aiRankingEnabled: boolean };
    expect(newValue.aiRankingEnabled).toBe(true);
  });
});
