// AI GRADE integration tests — synchronous text-only suggestion runs against the
// FakeAiProvider: prompt fidelity (stored deterministic ratings + pooled results +
// protocol PICO + RoB per-study buckets), latest-wins replacement, invalid-item counting,
// failure paths (provider error + malformed envelope), the no-assessment / no-pooled-result
// guards, AI-disabled 422, R9 tenancy, and permissions.
//
// NOTE: the "apply via updateDomainRating (origin AI_APPLIED + provenance metadata)" case
// from the contract lives with the grade service's own tests. Fixtures here generate a
// real fingerprinted deterministic draft, then customize the stored human-reviewed prose
// needed to make prompt fidelity assertions precise.
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/server/db";
import { AppError } from "@/server/errors";
import * as aiGrade from "@/server/services/ai-grade";
import * as analysis from "@/server/services/analysis";
import * as extraction from "@/server/services/extraction";
import * as grade from "@/server/services/grade";
import { resetAiProviderForTests, setAiProviderForTests } from "@/server/ai/provider";
import { GRADE_PROMPT_VERSION } from "@/server/ai/prompts/grade";
import { FakeAiProvider } from "../fake-ai-provider";
import { resetDb } from "../db-utils";
import {
  addOrgMember,
  addProjectMember,
  createProjectWithTeam,
  createTestCitation,
  createTestUser,
} from "../factories";

const ctx = (userId: string) => ({ userId });

async function expectAppError(promise: Promise<unknown>, code: string, messagePart?: string) {
  try {
    await promise;
    expect.fail(`expected AppError(${code}) but call succeeded`);
  } catch (err) {
    if (!(err instanceof AppError)) throw err;
    expect(err.code).toBe(code);
    if (messagePart) expect(err.message).toContain(messagePart);
  }
}

const BINARY_FIELDS = [
  { key: "e1", label: "Events (intervention)" },
  { key: "n1", label: "Total (intervention)" },
  { key: "e2", label: "Events (control)" },
  { key: "n2", label: "Total (control)" },
];

// Criner 190 + Slebos 97 participants = 287 total; pooled random RR ~3.00 [1.85, 4.87].
const STUDY_DATA = [
  { label: "Criner 2018", values: { e1: 60, n1: 128, e2: 10, n2: 62 } },
  { label: "Slebos 2019", values: { e1: 18, n1: 47, e2: 6, n2: 50 } },
];

async function setup() {
  const team = await createProjectWithTeam();
  const statistician = await createTestUser({ name: "Stan Statistician" });
  const extractor1 = await createTestUser({ name: "Extractor One" });
  const extractor2 = await createTestUser({ name: "Extractor Two" });
  const observer = await createTestUser({ name: "Olive Observer" });
  for (const u of [statistician, extractor1, extractor2, observer]) {
    await addOrgMember(team.org.id, u.id);
  }
  await addProjectMember(team.project.id, statistician.id, ["STATISTICIAN"]);
  await addProjectMember(team.project.id, extractor1.id, ["EXTRACTOR"]);
  await addProjectMember(team.project.id, extractor2.id, ["EXTRACTOR"]);
  await addProjectMember(team.project.id, observer.id, ["OBSERVER"]);

  await prisma.protocol.create({
    data: {
      projectId: team.project.id,
      reviewQuestion: "Does endobronchial valve therapy improve FEV1 response?",
      picoQuestions: {
        create: [
          {
            order: 0,
            question: "KQ1",
            population: "Adults with severe emphysema",
            intervention: "Endobronchial valves",
            comparator: "Standard of care",
            outcome: "FEV1 responder rate",
          },
        ],
      },
    },
  });

  const template = await prisma.extractionTemplate.create({
    data: {
      projectId: team.project.id,
      name: "Outcome form",
      status: "PUBLISHED",
      createdById: team.owner.id,
      fields: {
        create: BINARY_FIELDS.map((f, i) => ({
          key: f.key,
          label: f.label,
          type: "NUMBER",
          order: i,
        })),
      },
    },
    include: { fields: true },
  });

  // Dual-consensus extraction so computeOutcomeResults pools for any analysis.view holder.
  for (const spec of STUDY_DATA) {
    const citation = await createTestCitation(team.project.id);
    const study = await prisma.study.create({
      data: {
        projectId: team.project.id,
        label: spec.label,
        createdById: team.owner.id,
        reportLinks: { create: { citationId: citation.id, isPrimaryReport: true } },
      },
    });
    for (const extractor of [extractor1, extractor2]) {
      await prisma.extractionAssignment.create({
        data: { templateId: template.id, studyId: study.id, extractorId: extractor.id },
      });
      const { form } = await extraction.startForm(ctx(extractor.id), team.project.id, study.id, {
        templateId: template.id,
      });
      for (const field of template.fields) {
        await extraction.upsertValue(ctx(extractor.id), team.project.id, form.id, field.id, {
          value: spec.values[field.key as keyof typeof spec.values],
        });
      }
      await extraction.completeForm(ctx(extractor.id), team.project.id, form.id);
    }
  }

  const outcome = await analysis.createOutcome(ctx(statistician.id), team.project.id, {
    name: "FEV1 responders",
    measure: "RR",
    timepoint: "12 months",
    direction: "HIGHER_IS_BETTER",
    groupLabels: { g1: "Valve", g2: "Control" },
  });
  await analysis.replaceMappings(ctx(statistician.id), team.project.id, outcome.id, {
    mappings: [
      { role: "G1_EVENTS", templateId: template.id, fieldKey: "e1" },
      { role: "G1_TOTAL", templateId: template.id, fieldKey: "n1" },
      { role: "G2_EVENTS", templateId: template.id, fieldKey: "e2" },
      { role: "G2_TOTAL", templateId: template.id, fieldKey: "n2" },
    ],
  });

  return { ...team, statistician, extractor1, extractor2, observer, template, outcome };
}

type Setup = Awaited<ReturnType<typeof setup>>;

// Generate a real source fingerprint, then seed the stored human-reviewed Tier-1 prose.
// The RISK_OF_BIAS metrics.perStudy deliberately covers only Criner so the prompt join
// falls back to "unassessed" for Slebos.
async function seedAssessment(s: Setup, outcomeId: string) {
  const assessment = await grade.generateDraft(
    ctx(s.statistician.id),
    s.project.id,
    outcomeId,
    {},
  );
  const ratings = [
          {
            domain: "RISK_OF_BIAS",
            judgment: "NOT_SERIOUS",
            rationale:
              "Risk of bias across 2 pooled studies (RoB 2) — low: 1 study (66.1% weight). Judged not serious.",
            metrics: {
              weightPctByBucket: { low: 66.1, moderate: 0, high: 0, unclear: 0, unassessed: 33.9 },
              perStudy: [
                {
                  label: "Criner 2018",
                  judgmentLabel: "Low risk",
                  bucket: "low",
                  provenance: "consensus",
                  weightPct: 66.1,
                },
              ],
              thresholds: { verySeriousHighWeight: 50, seriousHighWeight: 20, seriousConcernWeight: 50 },
            },
          },
          {
            domain: "INCONSISTENCY",
            judgment: "NOT_SERIOUS",
            rationale: "I2 = 0% (Q = 0.03, df = 1, p = 0.85) — below the 40% threshold.",
            metrics: { i2: 0, q: 0.0344, df: 1, p: 0.8529, k: 2 },
          },
          {
            domain: "INDIRECTNESS",
            judgment: "NOT_SERIOUS",
            rationale: "PICO applicability is a human judgment — verify the match.",
            requiresReview: true,
            metrics: { automated: false },
          },
          {
            domain: "IMPRECISION",
            judgment: "SERIOUS",
            rationale:
              "Total participants 287 is below the 400 optimal information size; the CI does not cross the null.",
            metrics: { totalN: 287, oisThreshold: 400, oisShort: true, crossesNull: false },
          },
          {
            domain: "PUBLICATION_BIAS",
            judgment: "NOT_SERIOUS",
            rationale: "k = 2 is below the ~10-study minimum for funnel-based tests.",
            requiresReview: true,
            metrics: { k: 2, eggerP: null, eggerThreshold: 0.1 },
          },
        ] as const;
  for (const rating of ratings) {
    await prisma.gradeDomainRating.update({
      where: {
        assessmentId_domain: { assessmentId: assessment.id, domain: rating.domain },
      },
      data: {
        judgment: rating.judgment,
        rationale: rating.rationale,
        requiresReview: "requiresReview" in rating ? rating.requiresReview : false,
        metrics: rating.metrics,
        origin: "HUMAN",
        updatedById: s.statistician.id,
      },
    });
  }
  return prisma.gradeAssessment.findUniqueOrThrow({
    where: { id: assessment.id },
    include: { ratings: true },
  });
}

// A well-formed model response, deliberately out of canonical domain order.
const FULL_RESPONSE = {
  domains: [
    {
      domain: "PUBLICATION_BIAS",
      judgment: "NOT_SERIOUS",
      rationale: "With k = 2 studies no funnel-based test is informative.",
      confidence: 0.7,
    },
    {
      domain: "RISK_OF_BIAS",
      judgment: "NOT_SERIOUS",
      rationale: "66.1% of pooled weight is at low risk; the rest is unassessed.",
      confidence: 0.9,
    },
    {
      domain: "INCONSISTENCY",
      judgment: "NOT_SERIOUS",
      rationale: "I2 = 0% across the 2 pooled studies.",
      confidence: 1.5, // clamps to 1
    },
    {
      domain: "INDIRECTNESS",
      judgment: "NOT_SERIOUS",
      rationale: "Population and intervention match the protocol PICO.",
      confidence: 0.6,
    },
    {
      domain: "IMPRECISION",
      judgment: "SERIOUS",
      rationale: "  287 participants is below the 400 optimal information size.  ", // trims
      confidence: 0.8,
    },
  ],
};

const CANONICAL_ORDER = [
  "RISK_OF_BIAS",
  "INCONSISTENCY",
  "INDIRECTNESS",
  "IMPRECISION",
  "PUBLICATION_BIAS",
];

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

describe("ai grade suggestion runs", () => {
  it("drafts per-domain suggestions from stored ratings + pooled results with counts and audit", async () => {
    const s = await setup();
    await seedAssessment(s, s.outcome.id);
    fake.completeJson = FULL_RESPONSE;
    fake.completeUsage = { inputTokens: 500, outputTokens: 80 };

    const { run, suggestions } = await aiGrade.runGradeSuggestion(
      ctx(s.statistician.id),
      s.project.id,
      s.outcome.id,
    );
    expect(run).toMatchObject({
      status: "COMPLETED",
      analysisOutcomeId: s.outcome.id,
      totalDomains: 5,
      suggestedCount: 5,
      invalidCount: 0,
      provider: "anthropic",
      promptVersion: GRADE_PROMPT_VERSION,
      requestedById: s.statistician.id,
    });
    expect(run.usage).toEqual({ inputTokens: 500, outputTokens: 80 });
    expect(run.completedAt).not.toBeNull();

    // Returned in canonical domain order regardless of model output order, every row
    // stamped with the run's provenance.
    expect(suggestions.map((sg) => sg.domain)).toEqual(CANONICAL_ORDER);
    for (const sg of suggestions) {
      expect(sg).toMatchObject({
        runId: run.id,
        analysisOutcomeId: s.outcome.id,
        provider: run.provider,
        model: run.model,
        promptVersion: GRADE_PROMPT_VERSION,
      });
    }
    const byDomain = new Map(suggestions.map((sg) => [sg.domain, sg]));
    expect(byDomain.get("IMPRECISION")).toMatchObject({
      suggestedJudgment: "SERIOUS",
      rationale: "287 participants is below the 400 optimal information size.", // trimmed
      confidence: 0.8,
    });
    expect(byDomain.get("INCONSISTENCY")!.confidence).toBe(1); // clamped from 1.5
    expect(byDomain.get("INDIRECTNESS")).toMatchObject({
      suggestedJudgment: "NOT_SERIOUS",
      rationale:
        "Study-level population, intervention, comparator, and outcome characteristics were not provided to the AI, so indirectness cannot be verified. Retain no automatic downgrade and require human review against the protocol PICO.",
      confidence: null,
    });

    // The provider got a text-only structured call with the configured model.
    expect(fake.completeCalls).toHaveLength(1);
    expect(fake.completeCalls[0]!.model).toBe(run.model);
    const user = fake.completeCalls[0]!.prompt.user;
    // Outcome + protocol context.
    expect(user).toContain("Name: FEV1 responders");
    expect(user).toContain("Timepoint: 12 months");
    expect(user).toContain("Effect measure: RR (Risk ratio)");
    expect(user).toContain("Groups: Valve vs Control");
    expect(user).toContain("Does endobronchial valve therapy improve FEV1 response?");
    expect(user).toContain(
      "PICO 1 (KQ1) — P: Adults with severe emphysema | I: Endobronchial valves | C: Standard of care | O: FEV1 responder rate",
    );
    expect(user).toContain("Study-level PICO characteristics are not included");
    // Pooled summary (never provisional; totals from consensus values).
    expect(user).toContain("Model: RANDOM; k = 2 pooled studies; total participants: 287");
    expect(user).toContain("Risk ratio:");
    expect(user).toContain("I2 = 0%");
    // Study lines joined with the stored RoB perStudy buckets; Slebos has no entry ->
    // "unassessed" fallback.
    expect(user).toContain("- Criner 2018: n = 190; effect 2.91 [1.60, 5.28]; risk of bias: Low risk (low)");
    expect(user).toContain("- Slebos 2019: n = 97; effect 3.19 [1.39, 7.35]; risk of bias: unassessed");
    // Deterministic tier serialized in canonical order with judgments, review flags, metrics.
    expect(user).toContain("## IMPRECISION — SERIOUS");
    expect(user).toContain("## PUBLICATION_BIAS — NOT_SERIOUS (flagged for human review)");
    expect(user).toContain('"oisThreshold":400');
    const sectionOrder = CANONICAL_ORDER.map((d) => user.indexOf(`## ${d} —`));
    expect(sectionOrder.every((pos) => pos >= 0)).toBe(true);
    expect([...sectionOrder].sort((a, b) => a - b)).toEqual(sectionOrder);

    // Run-level audit only — suggestion rows are unaudited.
    const actions = await prisma.auditEvent.findMany({
      where: { projectId: s.project.id, action: { startsWith: "ai.grade" } },
      select: { action: true },
    });
    expect(actions.map((a) => a.action).sort()).toEqual(["ai.grade.completed", "ai.grade.started"]);
  });

  it("re-runs replace previous suggestions (latest-wins) and count invalid items", async () => {
    const s = await setup();
    await seedAssessment(s, s.outcome.id);
    fake.completeJson = FULL_RESPONSE;
    const { run: firstRun } = await aiGrade.runGradeSuggestion(
      ctx(s.statistician.id),
      s.project.id,
      s.outcome.id,
    );
    expect(firstRun.suggestedCount).toBe(5);

    fake.completeJson = {
      domains: [
        {
          domain: "IMPRECISION",
          judgment: "VERY_SERIOUS",
          rationale: "The CI crosses both appreciable bounds.",
          confidence: 0.4,
        },
        { domain: "IMPRECISION", judgment: "SERIOUS", rationale: "duplicate", confidence: 0.4 },
        { domain: "WRONG_DOMAIN", judgment: "SERIOUS", rationale: "unknown", confidence: 0.4 },
        { domain: "INCONSISTENCY", judgment: "MEDIUM", rationale: "bad judgment", confidence: 0.4 },
        "garbage",
      ],
    };
    const { run: secondRun, suggestions } = await aiGrade.runGradeSuggestion(
      ctx(s.statistician.id),
      s.project.id,
      s.outcome.id,
    );
    expect(secondRun).toMatchObject({ status: "COMPLETED", suggestedCount: 1, invalidCount: 4 });

    // Full replace: only the second run's valid domain remains.
    expect(suggestions).toHaveLength(1);
    expect(suggestions[0]).toMatchObject({
      runId: secondRun.id,
      domain: "IMPRECISION",
      suggestedJudgment: "VERY_SERIOUS",
    });
    const rows = await prisma.gradeDomainSuggestion.findMany({
      where: { analysisOutcomeId: s.outcome.id },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.runId).toBe(secondRun.id);
    // Both runs are retained as history.
    expect(await prisma.aiGradeRun.count({ where: { analysisOutcomeId: s.outcome.id } })).toBe(2);
  });

  it("does not let an older slow run overwrite a newer completed run", async () => {
    const s = await setup();
    await seedAssessment(s, s.outcome.id);

    let signalOlderStarted!: () => void;
    const olderStarted = new Promise<void>((resolve) => {
      signalOlderStarted = resolve;
    });
    let releaseOlder!: (value: { json: unknown; usage: undefined }) => void;
    const olderResponse = new Promise<{ json: unknown; usage: undefined }>((resolve) => {
      releaseOlder = resolve;
    });
    fake.completeStructured = async (request) => {
      fake.completeCalls.push(request);
      signalOlderStarted();
      return olderResponse;
    };

    const olderPromise = aiGrade.runGradeSuggestion(
      ctx(s.statistician.id),
      s.project.id,
      s.outcome.id,
    );
    await olderStarted;

    const newerProvider = new FakeAiProvider();
    newerProvider.completeJson = {
      domains: [
        {
          domain: "IMPRECISION",
          judgment: "VERY_SERIOUS",
          rationale: "The newer run found severe imprecision.",
          confidence: 0.95,
        },
      ],
    };
    setAiProviderForTests(newerProvider);
    const newer = await aiGrade.runGradeSuggestion(
      ctx(s.statistician.id),
      s.project.id,
      s.outcome.id,
    );
    expect(newer.run.suggestedCount).toBe(1);

    releaseOlder({ json: FULL_RESPONSE, usage: undefined });
    const older = await olderPromise;
    expect(older.run).toMatchObject({ status: "COMPLETED", suggestedCount: 0 });
    expect(older.suggestions).toEqual([]);

    const current = await prisma.gradeDomainSuggestion.findMany({
      where: { analysisOutcomeId: s.outcome.id },
    });
    expect(current).toHaveLength(1);
    expect(current[0]).toMatchObject({
      runId: newer.run.id,
      domain: "IMPRECISION",
      rationale: "The newer run found severe imprecision.",
    });
    const olderAudit = await prisma.auditEvent.findFirstOrThrow({
      where: {
        projectId: s.project.id,
        entityId: older.run.id,
        action: "ai.grade.completed",
      },
    });
    expect(olderAudit.metadata).toMatchObject({ superseded: true, suggestedCount: 0 });
  });

  it("does not publish a slow response after the assessment version changes", async () => {
    const s = await setup();
    await seedAssessment(s, s.outcome.id);

    let signalStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      signalStarted = resolve;
    });
    let release!: (value: { json: unknown; usage: undefined }) => void;
    const response = new Promise<{ json: unknown; usage: undefined }>((resolve) => {
      release = resolve;
    });
    fake.completeStructured = async (request) => {
      fake.completeCalls.push(request);
      signalStarted();
      return response;
    };

    const pending = aiGrade.runGradeSuggestion(
      ctx(s.statistician.id),
      s.project.id,
      s.outcome.id,
    );
    await started;
    await grade.updateDomainRating(
      ctx(s.statistician.id),
      s.project.id,
      s.outcome.id,
      "IMPRECISION",
      { rationale: "Human review completed while the AI provider call was in flight." },
    );
    release({ json: FULL_RESPONSE, usage: undefined });

    const completed = await pending;
    expect(completed.run).toMatchObject({ status: "COMPLETED", suggestedCount: 0 });
    expect(completed.suggestions).toEqual([]);
    expect(
      await prisma.gradeDomainSuggestion.count({ where: { analysisOutcomeId: s.outcome.id } }),
    ).toBe(0);
    const auditEvent = await prisma.auditEvent.findFirstOrThrow({
      where: { entityId: completed.run.id, action: "ai.grade.completed" },
    });
    expect(auditEvent.metadata).toMatchObject({
      superseded: true,
      supersededReason: "assessment_or_source_changed",
      suggestedCount: 0,
    });
  });

  it("does not publish a slow response after protocol source context changes", async () => {
    const s = await setup();
    await seedAssessment(s, s.outcome.id);

    let signalStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      signalStarted = resolve;
    });
    let release!: (value: { json: unknown; usage: undefined }) => void;
    const response = new Promise<{ json: unknown; usage: undefined }>((resolve) => {
      release = resolve;
    });
    fake.completeStructured = async (request) => {
      fake.completeCalls.push(request);
      signalStarted();
      return response;
    };

    const pending = aiGrade.runGradeSuggestion(
      ctx(s.statistician.id),
      s.project.id,
      s.outcome.id,
    );
    await started;
    await prisma.protocol.update({
      where: { projectId: s.project.id },
      data: { setting: "A newly restricted care setting" },
    });
    release({ json: FULL_RESPONSE, usage: undefined });

    const completed = await pending;
    expect(completed.run).toMatchObject({ status: "COMPLETED", suggestedCount: 0 });
    expect(completed.suggestions).toEqual([]);
    expect(
      await prisma.gradeDomainSuggestion.count({ where: { analysisOutcomeId: s.outcome.id } }),
    ).toBe(0);
  });

  it("marks the run FAILED on provider errors or malformed envelopes, keeping prior suggestions", async () => {
    const s = await setup();
    await seedAssessment(s, s.outcome.id);
    fake.completeJson = FULL_RESPONSE;
    const { run: goodRun } = await aiGrade.runGradeSuggestion(
      ctx(s.statistician.id),
      s.project.id,
      s.outcome.id,
    );

    // Provider throws.
    fake.failComplete = "boom 401";
    await expectAppError(
      aiGrade.runGradeSuggestion(ctx(s.statistician.id), s.project.id, s.outcome.id),
      "INVALID_STATE",
      "boom 401",
    );
    const failed = await prisma.aiGradeRun.findFirst({
      where: { analysisOutcomeId: s.outcome.id, status: "FAILED" },
      orderBy: { createdAt: "desc" },
    });
    expect(failed).toMatchObject({ error: "boom 401" });
    expect(failed!.completedAt).not.toBeNull();

    // Envelope mismatch -> parseGradeResult throws -> FAILED too.
    fake.failComplete = null;
    fake.completeJson = { nope: true };
    await expectAppError(
      aiGrade.runGradeSuggestion(ctx(s.statistician.id), s.project.id, s.outcome.id),
      "INVALID_STATE",
    );
    expect(
      await prisma.aiGradeRun.count({
        where: { analysisOutcomeId: s.outcome.id, status: "FAILED" },
      }),
    ).toBe(2);
    expect(
      await prisma.auditEvent.count({
        where: { projectId: s.project.id, action: "ai.grade.failed" },
      }),
    ).toBe(2);

    // The ingest tx never ran — the successful run's suggestions are untouched.
    const rows = await prisma.gradeDomainSuggestion.findMany({
      where: { analysisOutcomeId: s.outcome.id },
    });
    expect(rows).toHaveLength(5);
    expect(rows.every((r) => r.runId === goodRun.id)).toBe(true);
  });
});

describe("guards", () => {
  it("requires a deterministic draft, a pooled result, an enabled provider, and analysis.manage", async () => {
    const s = await setup();
    fake.completeJson = FULL_RESPONSE;

    // No GradeAssessment yet -> 422, and no run row is created.
    await expectAppError(
      aiGrade.runGradeSuggestion(ctx(s.statistician.id), s.project.id, s.outcome.id),
      "INVALID_STATE",
      "Generate the deterministic GRADE draft first",
    );
    expect(await prisma.aiGradeRun.count({ where: { analysisOutcomeId: s.outcome.id } })).toBe(0);

    // Assessment exists but the outcome pools nothing (no mappings/extraction data).
    const unpooled = await analysis.createOutcome(ctx(s.statistician.id), s.project.id, {
      name: "Unpooled outcome",
      measure: "RR",
    });
    await prisma.gradeAssessment.create({
      data: {
        analysisOutcomeId: unpooled.id,
        certainty: "MODERATE",
        generatedAt: new Date(),
        createdById: s.statistician.id,
      },
    });
    await expectAppError(
      aiGrade.runGradeSuggestion(ctx(s.statistician.id), s.project.id, unpooled.id),
      "INVALID_STATE",
      "No pooled result",
    );
    expect(await prisma.aiGradeRun.count({ where: { analysisOutcomeId: unpooled.id } })).toBe(0);

    // Permissions: analysis.view alone (OBSERVER) or neither (REVIEWER) cannot run.
    await seedAssessment(s, s.outcome.id);
    await expectAppError(
      aiGrade.runGradeSuggestion(ctx(s.observer.id), s.project.id, s.outcome.id),
      "FORBIDDEN",
    );
    await expectAppError(
      aiGrade.runGradeSuggestion(ctx(s.reviewer1.id), s.project.id, s.outcome.id),
      "FORBIDDEN",
    );

    // Disabled provider (no API key configured).
    setAiProviderForTests(null);
    await expectAppError(
      aiGrade.runGradeSuggestion(ctx(s.statistician.id), s.project.id, s.outcome.id),
      "INVALID_STATE",
    );
    setAiProviderForTests(fake);

    // Statistician manages: the same outcome now runs clean.
    const { run } = await aiGrade.runGradeSuggestion(
      ctx(s.statistician.id),
      s.project.id,
      s.outcome.id,
    );
    expect(run.status).toBe("COMPLETED");
  });

  it("requires regeneration when evidence or protocol context changed", async () => {
    const s = await setup();
    await seedAssessment(s, s.outcome.id);
    fake.completeJson = FULL_RESPONSE;
    await prisma.protocol.update({
      where: { projectId: s.project.id },
      data: { population: "A newly restricted protocol population" },
    });

    await expectAppError(
      aiGrade.runGradeSuggestion(ctx(s.statistician.id), s.project.id, s.outcome.id),
      "INVALID_STATE",
      "regenerate GRADE",
    );
    expect(await prisma.aiGradeRun.count({ where: { analysisOutcomeId: s.outcome.id } })).toBe(0);
  });

  it("R9: foreign-project or unknown outcomes 404 without leaking existence", async () => {
    const s = await setup();
    fake.completeJson = FULL_RESPONSE;

    const other = await createProjectWithTeam();
    const foreignOutcome = await prisma.analysisOutcome.create({
      data: {
        projectId: other.project.id,
        name: "Foreign outcome",
        measure: "RR",
        createdById: other.owner.id,
      },
    });

    await expectAppError(
      aiGrade.runGradeSuggestion(ctx(s.statistician.id), s.project.id, foreignOutcome.id),
      "NOT_FOUND",
    );
    await expectAppError(
      aiGrade.runGradeSuggestion(ctx(s.statistician.id), s.project.id, "missing-outcome-id"),
      "NOT_FOUND",
    );
    expect(
      await prisma.aiGradeRun.count({
        where: { analysisOutcomeId: { in: [s.outcome.id, foreignOutcome.id] } },
      }),
    ).toBe(0);
  });
});
