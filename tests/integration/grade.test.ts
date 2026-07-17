// GRADE integration tests — deterministic draft generation over real extraction data,
// human/AI-applied rating edits, review lifecycle, RoB roll-up precedence (incl. the
// caller-independent single-assessment withholding), Summary of Findings, deleteOutcome
// cascade, and the GRADE export (capability mirror + CSV injection guard).
import { beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/server/db";
import { AppError } from "@/server/errors";
import * as analysis from "@/server/services/analysis";
import * as extraction from "@/server/services/extraction";
import * as grade from "@/server/services/grade";
import { createExport, downloadExport } from "@/server/services/exports";
import { listAuditEvents } from "@/server/services/audit-query";
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
  { key: "e1", label: "Events (intervention)", type: "NUMBER" as const },
  { key: "n1", label: "Total (intervention)", type: "NUMBER" as const },
  { key: "e2", label: "Events (control)", type: "NUMBER" as const },
  { key: "n2", label: "Total (control)", type: "NUMBER" as const },
];

const ROB_SCALE = [
  { value: "low", label: "Low risk", severity: 1 },
  { value: "some_concerns", label: "Some concerns", severity: 2 },
  { value: "high", label: "High risk", severity: 3 },
];

async function setup() {
  const team = await createProjectWithTeam();
  const statistician = await createTestUser({ name: "Stan Statistician" });
  const extractor1 = await createTestUser({ name: "Extractor One" });
  const extractor2 = await createTestUser({ name: "Extractor Two" });
  const observer = await createTestUser({ name: "Olive Observer" });
  const librarian = await createTestUser({ name: "Libby Librarian" });
  for (const u of [statistician, extractor1, extractor2, observer, librarian]) {
    await addOrgMember(team.org.id, u.id);
  }
  await addProjectMember(team.project.id, statistician.id, ["STATISTICIAN"]);
  await addProjectMember(team.project.id, extractor1.id, ["EXTRACTOR"]);
  await addProjectMember(team.project.id, extractor2.id, ["EXTRACTOR"]);
  await addProjectMember(team.project.id, observer.id, ["OBSERVER"]);
  await addProjectMember(team.project.id, librarian.id, ["LIBRARIAN"]);

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
          type: f.type,
          order: i,
        })),
      },
    },
    include: { fields: true },
  });

  async function makeStudy(label: string) {
    const citation = await createTestCitation(team.project.id);
    const study = await prisma.study.create({
      data: {
        projectId: team.project.id,
        label,
        createdById: team.owner.id,
        reportLinks: { create: { citationId: citation.id, isPrimaryReport: true } },
      },
    });
    await prisma.extractionAssignment.createMany({
      data: [extractor1.id, extractor2.id].map((extractorId) => ({
        templateId: template.id,
        studyId: study.id,
        extractorId,
      })),
    });
    return study;
  }

  return {
    ...team,
    statistician,
    extractor1,
    extractor2,
    observer,
    librarian,
    template,
    makeStudy,
  };
}

type Setup = Awaited<ReturnType<typeof setup>>;

async function fillForm(
  s: Setup,
  studyId: string,
  extractorId: string,
  values: Record<string, number>,
) {
  const { form } = await extraction.startForm(ctx(extractorId), s.project.id, studyId, {
    templateId: s.template.id,
  });
  const byKey = new Map(s.template.fields.map((f) => [f.key, f]));
  for (const [key, value] of Object.entries(values)) {
    await extraction.upsertValue(ctx(extractorId), s.project.id, form.id, byKey.get(key)!.id, {
      value,
    });
  }
  await extraction.completeForm(ctx(extractorId), s.project.id, form.id);
}

// Two studies with dual-extractor consensus: pooled random RR ~3.00 [1.85, 4.87],
// I2 = 0, totalN = 287 (< OIS 400 -> imprecision SERIOUS; CI does not cross 1).
async function extractedBinaryOutcome(s: Setup) {
  const alpha = await s.makeStudy("Alpha 2019");
  const bravo = await s.makeStudy("Bravo 2021");
  for (const extractorId of [s.extractor1.id, s.extractor2.id]) {
    await fillForm(s, alpha.id, extractorId, { e1: 60, n1: 128, e2: 10, n2: 62 });
    await fillForm(s, bravo.id, extractorId, { e1: 18, n1: 47, e2: 6, n2: 50 });
  }
  const outcome = await analysis.createOutcome(ctx(s.statistician.id), s.project.id, {
    name: "Responders",
    measure: "RR",
    timepoint: "12 months",
    groupLabels: { g1: "Valve", g2: "Control" },
  });
  await analysis.replaceMappings(ctx(s.statistician.id), s.project.id, outcome.id, {
    mappings: [
      { role: "G1_EVENTS", templateId: s.template.id, fieldKey: "e1" },
      { role: "G1_TOTAL", templateId: s.template.id, fieldKey: "n1" },
      { role: "G2_EVENTS", templateId: s.template.id, fieldKey: "e2" },
      { role: "G2_TOTAL", templateId: s.template.id, fieldKey: "n2" },
    ],
  });
  return { outcome, alpha, bravo };
}

async function makeRobTool(s: Setup) {
  return prisma.riskOfBiasTool.create({
    data: {
      projectId: s.project.id,
      name: "Test RoB Tool",
      judgmentScale: ROB_SCALE,
      status: "PUBLISHED",
      createdById: s.owner.id,
      domains: { create: [{ name: "D1", order: 0 }, { name: "D2", order: 1 }] },
    },
    include: { domains: { orderBy: { order: "asc" } } },
  });
}

async function completeAssessment(
  toolId: string,
  studyId: string,
  assessorId: string,
  overall: string | null,
  domainJudgments: { domainId: string; judgment: string }[] = [],
) {
  return prisma.riskOfBiasAssessment.create({
    data: {
      toolId,
      studyId,
      assessorId,
      status: "COMPLETED",
      overallJudgment: overall,
      completedAt: new Date(),
      judgments: { create: domainJudgments },
    },
  });
}

const ratingFor = (payload: grade.GradeAssessmentPayload, domain: string) =>
  payload.ratings.find((r) => r.domain === domain)!;

beforeAll(async () => {
  await resetDb();
});

describe("generateDraft", () => {
  it("drafts all five domains, stores certainty, and audits", async () => {
    const s = await setup();
    const { outcome, alpha, bravo } = await extractedBinaryOutcome(s);
    // Consensus "low" overall RoB on both studies -> RISK_OF_BIAS not serious.
    const tool = await makeRobTool(s);
    for (const study of [alpha, bravo]) {
      await completeAssessment(tool.id, study.id, s.reviewer1.id, "low");
      await completeAssessment(tool.id, study.id, s.reviewer2.id, "low");
    }

    const payload = await grade.generateDraft(ctx(s.statistician.id), s.project.id, outcome.id, {});
    expect(payload).toMatchObject({
      status: "DRAFT",
      startingLevel: "HIGH",
      certainty: "MODERATE",
      points: 3,
      reviewedBy: null,
    });
    expect(payload.ratings.map((r) => r.domain)).toEqual([
      "RISK_OF_BIAS",
      "INCONSISTENCY",
      "INDIRECTNESS",
      "IMPRECISION",
      "PUBLICATION_BIAS",
    ]);
    expect(payload.ratings.every((r) => r.origin === "AUTO")).toBe(true);

    const rob = ratingFor(payload, "RISK_OF_BIAS");
    expect(rob.judgment).toBe("NOT_SERIOUS");
    expect(rob.requiresReview).toBe(false);
    const robMetrics = rob.metrics as {
      weightPctByBucket: Record<string, number>;
      perStudy: { studyId: string; provenance: string; bucket: string }[];
    };
    expect(robMetrics.weightPctByBucket.low).toBeCloseTo(100, 3);
    expect(robMetrics.perStudy).toHaveLength(2);
    expect(new Set(robMetrics.perStudy.map((p) => p.studyId))).toEqual(
      new Set([alpha.id, bravo.id]),
    );
    expect(robMetrics.perStudy.every((p) => p.provenance === "consensus")).toBe(true);

    expect(ratingFor(payload, "INCONSISTENCY")).toMatchObject({
      judgment: "NOT_SERIOUS",
      requiresReview: false,
    });
    expect(ratingFor(payload, "INDIRECTNESS")).toMatchObject({
      judgment: "NOT_SERIOUS",
      requiresReview: true,
    });
    const imprecision = ratingFor(payload, "IMPRECISION");
    expect(imprecision.judgment).toBe("SERIOUS"); // totalN 287 < 400, CI does not cross 1
    expect((imprecision.metrics as { totalN: number }).totalN).toBe(287);
    expect((imprecision.metrics as { crossesNull: boolean }).crossesNull).toBe(false);
    expect(ratingFor(payload, "PUBLICATION_BIAS")).toMatchObject({
      judgment: "NOT_SERIOUS",
      requiresReview: true, // k = 2 below the funnel-test minimum
    });

    const audits = await prisma.auditEvent.findMany({
      where: { projectId: s.project.id, action: "grade.assessment.generated" },
    });
    expect(audits).toHaveLength(1);
    expect(audits[0]!.entityType).toBe("GradeAssessment");
    expect(audits[0]!.metadata).toMatchObject({
      k: 2,
      certainty: "MODERATE",
      points: 3,
      startingLevel: "HIGH",
      preservedDomains: [],
    });

    // The view reflects the fresh draft: nothing stale, draftable, points recomputed.
    const view = await grade.getGradeView(ctx(s.statistician.id), s.project.id, outcome.id);
    expect(view.canDraft).toBe(true);
    expect(view.staleDomains).toEqual([]);
    expect(view.assessment!.points).toBe(3);
    expect(view.suggestions).toEqual([]);
    expect(view.latestRun).toBeNull();
  });

  it("refuses when nothing pools (k = 0)", async () => {
    const s = await setup();
    const outcome = await analysis.createOutcome(ctx(s.statistician.id), s.project.id, {
      name: "Unmapped",
      measure: "RR",
    });
    await expectAppError(
      grade.generateDraft(ctx(s.statistician.id), s.project.id, outcome.id, {}),
      "INVALID_STATE",
    );
    const view = await grade.getGradeView(ctx(s.statistician.id), s.project.id, outcome.id);
    expect(view).toMatchObject({ assessment: null, canDraft: false, staleDomains: [] });
  });

  it("never persists an owner's pre-consensus SINGLE extraction in a shared draft", async () => {
    const s = await setup();
    const study = await s.makeStudy("Pending co-extraction");
    await fillForm(s, study.id, s.extractor1.id, { e1: 30, n1: 60, e2: 15, n2: 60 });
    const outcome = await analysis.createOutcome(ctx(s.statistician.id), s.project.id, {
      name: "Final-only responders",
      measure: "RR",
    });
    await analysis.replaceMappings(ctx(s.statistician.id), s.project.id, outcome.id, {
      mappings: [
        { role: "G1_EVENTS", templateId: s.template.id, fieldKey: "e1" },
        { role: "G1_TOTAL", templateId: s.template.id, fieldKey: "n1" },
        { role: "G2_EVENTS", templateId: s.template.id, fieldKey: "e2" },
        { role: "G2_TOTAL", templateId: s.template.id, fieldKey: "n2" },
      ],
    });

    // OWNER may inspect this value in ordinary requester-relative analysis.
    const ordinary = await analysis.computeOutcomeResults(
      ctx(s.owner.id),
      s.project.id,
      outcome.id,
    );
    const ordinaryRow = ordinary.rows.find((row) => row.studyId === study.id)!;
    expect(ordinaryRow.status).toBe("included");
    expect(ordinaryRow.values.G1_EVENTS).toEqual({ value: 30, source: "SINGLE" });

    // GRADE is shared, so its internal final-only computation must withhold the same value.
    await expectAppError(
      grade.generateDraft(ctx(s.owner.id), s.project.id, outcome.id, {}),
      "INVALID_STATE",
    );
    expect(
      await prisma.gradeAssessment.count({ where: { analysisOutcomeId: outcome.id } }),
    ).toBe(0);
    expect(
      await prisma.auditEvent.count({
        where: {
          projectId: s.project.id,
          entityType: "GradeAssessment",
          action: "grade.assessment.generated",
        },
      }),
    ).toBe(0);

    // Once the co-extractor agrees, the caller-independent final value can be persisted.
    await fillForm(s, study.id, s.extractor2.id, { e1: 30, n1: 60, e2: 15, n2: 60 });
    const drafted = await grade.generateDraft(ctx(s.owner.id), s.project.id, outcome.id, {});
    expect(drafted.ratings).toHaveLength(5);
    expect(
      await prisma.gradeAssessment.count({ where: { analysisOutcomeId: outcome.id } }),
    ).toBe(1);
  });

  it("regenerates: preserves HUMAN ratings, refreshes AUTO, reports staleness first", async () => {
    const s = await setup();
    const { outcome, bravo } = await extractedBinaryOutcome(s);
    await grade.generateDraft(ctx(s.statistician.id), s.project.id, outcome.id, {});
    const humanRationale =
      "Population, intervention and comparator match the protocol PICO; outcome measured at the protocol timepoint.";
    await grade.updateDomainRating(ctx(s.statistician.id), s.project.id, outcome.id, "INDIRECTNESS", {
      rationale: humanRationale,
    });

    // Results change under the stored draft -> AUTO domains stale, HUMAN never stale.
    await analysis.setStudyExclusion(ctx(s.statistician.id), s.project.id, outcome.id, bravo.id, {
      excluded: true,
      reason: "Sensitivity: cohort overlap suspected",
    });
    const stale = await grade.getGradeView(ctx(s.statistician.id), s.project.id, outcome.id);
    expect(stale.staleDomains).toContain("INCONSISTENCY");
    expect(stale.staleDomains).toContain("IMPRECISION");
    expect(stale.staleDomains).not.toContain("INDIRECTNESS");

    const regenerated = await grade.generateDraft(
      ctx(s.statistician.id),
      s.project.id,
      outcome.id,
      {},
    );
    const indirectness = ratingFor(regenerated, "INDIRECTNESS");
    expect(indirectness.origin).toBe("HUMAN");
    expect(indirectness.rationale).toBe(humanRationale);
    expect(indirectness.requiresReview).toBe(false);
    const inconsistency = ratingFor(regenerated, "INCONSISTENCY");
    expect(inconsistency.origin).toBe("AUTO");
    expect((inconsistency.metrics as { k: number }).k).toBe(1); // refreshed to the k=1 world
    expect(inconsistency.requiresReview).toBe(true);

    const audits = await prisma.auditEvent.findMany({
      where: { projectId: s.project.id, action: "grade.assessment.generated" },
      orderBy: { createdAt: "asc" },
    });
    expect(audits).toHaveLength(2);
    expect(audits[1]!.metadata).toMatchObject({ k: 1, preservedDomains: ["INDIRECTNESS"] });

    const after = await grade.getGradeView(ctx(s.statistician.id), s.project.id, outcome.id);
    expect(after.staleDomains).toEqual([]);
  });

  it("preserves a human edit and its certainty during overlapping regeneration", async () => {
    const s = await setup();
    const { outcome } = await extractedBinaryOutcome(s);
    await grade.generateDraft(ctx(s.statistician.id), s.project.id, outcome.id, {});
    const rationale = "Human review found no important risk-of-bias limitation.";

    // Start both operations without awaiting either. Whichever obtains the parent lock first,
    // the final state must retain the human-touched domain and recompute certainty from it.
    await Promise.all([
      grade.updateDomainRating(
        ctx(s.statistician.id),
        s.project.id,
        outcome.id,
        "RISK_OF_BIAS",
        { judgment: "NOT_SERIOUS", rationale },
      ),
      grade.generateDraft(ctx(s.statistician.id), s.project.id, outcome.id, {}),
    ]);

    const view = await grade.getGradeView(ctx(s.statistician.id), s.project.id, outcome.id);
    expect(view.assessment).not.toBeNull();
    expect(ratingFor(view.assessment!, "RISK_OF_BIAS")).toMatchObject({
      judgment: "NOT_SERIOUS",
      rationale,
      origin: "HUMAN",
      requiresReview: false,
    });
    expect(view.assessment!.certainty).toBe("MODERATE");
    expect(view.assessment!.points).toBe(3);
  });

  it("invalidates a draft when the resolved RoB tool identity changes", async () => {
    const s = await setup();
    const { outcome, alpha, bravo } = await extractedBinaryOutcome(s);
    const tool = await makeRobTool(s);
    for (const study of [alpha, bravo]) {
      await completeAssessment(tool.id, study.id, s.reviewer1.id, "low");
      await completeAssessment(tool.id, study.id, s.reviewer2.id, "low");
    }
    const drafted = await grade.generateDraft(
      ctx(s.statistician.id),
      s.project.id,
      outcome.id,
      {},
    );
    expect(ratingFor(drafted, "RISK_OF_BIAS").rationale).toContain("Test RoB Tool");

    await prisma.riskOfBiasTool.update({
      where: { id: tool.id },
      data: { name: "Renamed RoB Tool" },
    });
    const stale = await grade.getGradeView(ctx(s.statistician.id), s.project.id, outcome.id);
    expect(stale.outOfDate).toBe(true);
    expect(stale.staleDomains).toContain("RISK_OF_BIAS");

    const regenerated = await grade.generateDraft(
      ctx(s.statistician.id),
      s.project.id,
      outcome.id,
      {},
    );
    expect(ratingFor(regenerated, "RISK_OF_BIAS").rationale).toContain("Renamed RoB Tool");
  });
});

describe("rating edits + review lifecycle", () => {
  it("human edit sets HUMAN origin, recomputes certainty, flips REVIEWED to DRAFT, audits", async () => {
    const s = await setup();
    const { outcome } = await extractedBinaryOutcome(s);
    // No RoB assessments: RISK_OF_BIAS rolls up unassessed -> SERIOUS; with imprecision
    // SERIOUS the draft lands at 4 - 2 = 2 (LOW).
    const drafted = await grade.generateDraft(ctx(s.statistician.id), s.project.id, outcome.id, {});
    expect(drafted.certainty).toBe("LOW");
    await grade.markReviewed(ctx(s.statistician.id), s.project.id, outcome.id);

    const updated = await grade.updateDomainRating(
      ctx(s.statistician.id),
      s.project.id,
      outcome.id,
      "IMPRECISION",
      { judgment: "NOT_SERIOUS", rationale: "OIS satisfied against the protocol MID." },
    );
    expect(updated.status).toBe("DRAFT"); // any edit reopens the review
    expect(updated.reviewedBy).toBeNull();
    expect(updated.reviewedAt).toBeNull();
    expect(updated.certainty).toBe("MODERATE"); // only the RoB downgrade remains
    const imprecision = ratingFor(updated, "IMPRECISION");
    expect(imprecision).toMatchObject({
      judgment: "NOT_SERIOUS",
      origin: "HUMAN",
      requiresReview: false,
    });

    const audits = await prisma.auditEvent.findMany({
      where: { projectId: s.project.id, action: "grade.rating.updated" },
    });
    expect(audits).toHaveLength(1);
    expect(audits[0]!.entityType).toBe("GradeDomainRating");
    expect(audits[0]!.previousValue).toMatchObject({ judgment: "SERIOUS", origin: "AUTO" });
    expect(audits[0]!.newValue).toMatchObject({ judgment: "NOT_SERIOUS", origin: "HUMAN" });
  });

  it("applies an AI suggestion server-authoritatively (origin AI_APPLIED + provenance)", async () => {
    const s = await setup();
    const { outcome } = await extractedBinaryOutcome(s);
    await grade.generateDraft(ctx(s.statistician.id), s.project.id, outcome.id, {});
    const run = await prisma.aiGradeRun.create({
      data: {
        projectId: s.project.id,
        analysisOutcomeId: outcome.id,
        status: "COMPLETED",
        provider: "fake",
        model: "fake-model-1",
        promptVersion: "grade-v1",
        totalDomains: 5,
        requestedById: s.statistician.id,
      },
    });
    const suggestion = await prisma.gradeDomainSuggestion.create({
      data: {
        runId: run.id,
        analysisOutcomeId: outcome.id,
        domain: "INCONSISTENCY",
        suggestedJudgment: "SERIOUS",
        rationale: "AI: effect directions diverge across the two trials.",
        confidence: 0.8,
        provider: "fake",
        model: "fake-model-1",
        promptVersion: "grade-v1",
      },
    });

    // Wrong domain and unknown ids are rejected before anything is written.
    await expectAppError(
      grade.updateDomainRating(ctx(s.statistician.id), s.project.id, outcome.id, "IMPRECISION", {
        appliedSuggestionId: suggestion.id,
      }),
      "VALIDATION",
    );
    await expectAppError(
      grade.updateDomainRating(ctx(s.statistician.id), s.project.id, outcome.id, "INCONSISTENCY", {
        appliedSuggestionId: "nope",
      }),
      "NOT_FOUND",
    );

    const applied = await grade.updateDomainRating(
      ctx(s.statistician.id),
      s.project.id,
      outcome.id,
      "INCONSISTENCY",
      { appliedSuggestionId: suggestion.id },
    );
    const rating = ratingFor(applied, "INCONSISTENCY");
    expect(rating).toMatchObject({
      judgment: "SERIOUS",
      rationale: suggestion.rationale,
      origin: "AI_APPLIED",
      requiresReview: false,
    });
    expect(applied.certainty).toBe("VERY_LOW"); // rob + imprecision + inconsistency = -3

    const audit = await prisma.auditEvent.findFirst({
      where: { projectId: s.project.id, action: "grade.rating.updated" },
      orderBy: { createdAt: "desc" },
    });
    expect(audit!.metadata).toMatchObject({
      appliedFromSuggestionId: suggestion.id,
      aiProvider: "fake",
      aiModel: "fake-model-1",
    });

    // The view keeps the run history, but applying one item invalidates the suggestion set
    // because it was grounded in the pre-edit assessment version.
    const view = await grade.getGradeView(ctx(s.statistician.id), s.project.id, outcome.id);
    expect(view.latestRun!.id).toBe(run.id);
    expect(view.suggestions).toEqual([]);
  });

  it("setStartingLevel recomputes certainty from the LOW anchor", async () => {
    const s = await setup();
    const { outcome } = await extractedBinaryOutcome(s);
    const drafted = await grade.generateDraft(ctx(s.statistician.id), s.project.id, outcome.id, {});
    expect(drafted).toMatchObject({ startingLevel: "HIGH", certainty: "LOW", points: 2 });

    const lowered = await grade.setStartingLevel(ctx(s.statistician.id), s.project.id, outcome.id, {
      startingLevel: "LOW",
    });
    expect(lowered).toMatchObject({
      startingLevel: "LOW",
      certainty: "VERY_LOW",
      points: 1, // 2 - 2 clamps at the floor
      status: "DRAFT",
    });

    const audit = await prisma.auditEvent.findFirst({
      where: { projectId: s.project.id, action: "grade.assessment.updated" },
    });
    expect(audit!.previousValue).toMatchObject({ startingLevel: "HIGH", certainty: "LOW" });
    expect(audit!.newValue).toMatchObject({ startingLevel: "LOW", certainty: "VERY_LOW" });
  });

  it("treats the same starting-level PATCH as a no-op without un-reviewing", async () => {
    const s = await setup();
    const { outcome } = await extractedBinaryOutcome(s);
    await grade.generateDraft(ctx(s.statistician.id), s.project.id, outcome.id, {});
    const reviewed = await grade.markReviewed(ctx(s.statistician.id), s.project.id, outcome.id);

    const unchanged = await grade.setStartingLevel(
      ctx(s.statistician.id),
      s.project.id,
      outcome.id,
      { startingLevel: "HIGH" },
    );
    expect(unchanged).toMatchObject({
      startingLevel: "HIGH",
      certainty: reviewed.certainty,
      status: "REVIEWED",
      reviewedBy: reviewed.reviewedBy,
    });
    expect(unchanged.reviewedAt).toEqual(reviewed.reviewedAt);
    expect(unchanged.updatedAt).toEqual(reviewed.updatedAt);
    expect(
      await prisma.auditEvent.count({
        where: { projectId: s.project.id, action: "grade.assessment.updated" },
      }),
    ).toBe(0);
  });

  it("markReviewed records the reviewer and rejects a second review", async () => {
    const s = await setup();
    const { outcome } = await extractedBinaryOutcome(s);
    await grade.generateDraft(ctx(s.statistician.id), s.project.id, outcome.id, {});

    const reviewed = await grade.markReviewed(ctx(s.statistician.id), s.project.id, outcome.id);
    expect(reviewed.status).toBe("REVIEWED");
    expect(reviewed.reviewedBy).toMatchObject({ id: s.statistician.id, name: "Stan Statistician" });
    expect(reviewed.reviewedAt).not.toBeNull();

    await expectAppError(
      grade.markReviewed(ctx(s.statistician.id), s.project.id, outcome.id),
      "INVALID_STATE",
    );
    expect(
      await prisma.auditEvent.count({
        where: { projectId: s.project.id, action: "grade.assessment.reviewed" },
      }),
    ).toBe(1);

    // Reviewing an outcome that has no assessment yet is a 422, not a crash.
    const bare = await analysis.createOutcome(ctx(s.statistician.id), s.project.id, {
      name: "Bare",
      measure: "RR",
    });
    await expectAppError(
      grade.markReviewed(ctx(s.statistician.id), s.project.id, bare.id),
      "INVALID_STATE",
    );
  });

  it("rejects review while AUTO ratings are stale or their pooled source is unavailable", async () => {
    const s = await setup();
    const { outcome, alpha, bravo } = await extractedBinaryOutcome(s);
    await grade.generateDraft(ctx(s.statistician.id), s.project.id, outcome.id, {});

    // One remaining pooled study keeps the source available, but changes live AUTO rules.
    await analysis.setStudyExclusion(ctx(s.statistician.id), s.project.id, outcome.id, bravo.id, {
      excluded: true,
      reason: "Sensitivity analysis",
    });
    const stale = await grade.getGradeView(ctx(s.statistician.id), s.project.id, outcome.id);
    expect(stale.sourceUnavailable).toBe(false);
    expect(stale.outOfDate).toBe(true);
    expect(stale.staleDomains.length).toBeGreaterThan(0);

    // Converting every visibly stale AUTO domain to HUMAN must not erase assessment-level
    // staleness. This was the original bypass: staleDomains became empty and review passed.
    for (const domain of stale.staleDomains) {
      const rating = ratingFor(stale.assessment!, domain);
      await grade.updateDomainRating(
        ctx(s.statistician.id),
        s.project.id,
        outcome.id,
        domain,
        { judgment: rating.judgment, rationale: rating.rationale },
      );
    }
    const touched = await grade.getGradeView(ctx(s.statistician.id), s.project.id, outcome.id);
    expect(touched.staleDomains).toEqual([]);
    expect(touched.outOfDate).toBe(true);
    await expectAppError(
      grade.markReviewed(ctx(s.statistician.id), s.project.id, outcome.id),
      "INVALID_STATE",
    );

    // Removing the final pooled study is a distinct source-unavailable state and must also
    // remain unreviewable rather than blessing certainty beside a k=0 result.
    await analysis.setStudyExclusion(ctx(s.statistician.id), s.project.id, outcome.id, alpha.id, {
      excluded: true,
      reason: "No eligible studies remain",
    });
    const unavailable = await grade.getGradeView(
      ctx(s.statistician.id),
      s.project.id,
      outcome.id,
    );
    expect(unavailable).toMatchObject({ canDraft: false, sourceUnavailable: true });
    expect(unavailable.outOfDate).toBe(true);
    expect(unavailable.staleDomains.length).toBeGreaterThan(0);
    await expectAppError(
      grade.markReviewed(ctx(s.statistician.id), s.project.id, outcome.id),
      "INVALID_STATE",
    );

    const assessment = await prisma.gradeAssessment.findUniqueOrThrow({
      where: { analysisOutcomeId: outcome.id },
    });
    expect(assessment.status).toBe("DRAFT");
    expect(
      await prisma.auditEvent.count({
        where: { projectId: s.project.id, action: "grade.assessment.reviewed" },
      }),
    ).toBe(0);
  });

  it("fingerprints protocol applicability context and treats legacy null fingerprints as stale", async () => {
    const s = await setup();
    const { outcome } = await extractedBinaryOutcome(s);
    const drafted = await grade.generateDraft(ctx(s.statistician.id), s.project.id, outcome.id, {});
    const run = await prisma.aiGradeRun.create({
      data: {
        projectId: s.project.id,
        analysisOutcomeId: outcome.id,
        status: "COMPLETED",
        provider: "fake",
        model: "fake-model-1",
        promptVersion: "grade-v2",
        totalDomains: 5,
        requestedById: s.statistician.id,
      },
    });
    const suggestion = await prisma.gradeDomainSuggestion.create({
      data: {
        runId: run.id,
        analysisOutcomeId: outcome.id,
        domain: "IMPRECISION",
        suggestedJudgment: "NOT_SERIOUS",
        rationale: "AI suggestion grounded in the original protocol context.",
        provider: "fake",
        model: "fake-model-1",
        promptVersion: "grade-v2",
      },
    });

    await prisma.protocol.create({
      data: {
        projectId: s.project.id,
        reviewQuestion: "A materially revised population and intervention question",
      },
    });
    const changedContext = await grade.getGradeView(
      ctx(s.statistician.id),
      s.project.id,
      outcome.id,
    );
    expect(changedContext).toMatchObject({
      sourceUnavailable: false,
      outOfDate: true,
      staleDomains: [],
      suggestions: [],
    });
    await expectAppError(
      grade.updateDomainRating(
        ctx(s.statistician.id),
        s.project.id,
        outcome.id,
        "IMPRECISION",
        { appliedSuggestionId: suggestion.id },
      ),
      "INVALID_STATE",
      "regenerate GRADE",
    );
    expect(ratingFor(drafted, "IMPRECISION").origin).toBe("AUTO");
    await expectAppError(
      grade.markReviewed(ctx(s.statistician.id), s.project.id, outcome.id),
      "INVALID_STATE",
      "protocol applicability context changed",
    );
    const staleSof = await grade.computeSof(ctx(s.observer.id), s.project.id);
    expect(staleSof.rows[0]!.certainty).toMatchObject({ stale: true, sourceUnavailable: false });
    expect(staleSof.rows[0]!.footnotes).toEqual([
      "GRADE assessment is out of date: the analysis outcome or protocol applicability context changed.",
    ]);

    await grade.generateDraft(ctx(s.statistician.id), s.project.id, outcome.id, {});
    await prisma.gradeAssessment.update({
      where: { analysisOutcomeId: outcome.id },
      data: { sourceFingerprint: null },
    });
    const legacy = await grade.getGradeView(ctx(s.statistician.id), s.project.id, outcome.id);
    expect(legacy).toMatchObject({ outOfDate: true, staleDomains: [] });
    await expectAppError(
      grade.markReviewed(ctx(s.statistician.id), s.project.id, outcome.id),
      "INVALID_STATE",
    );
  });

  it("keeps prompt-neutral suggestions across starting-level and review transitions", async () => {
    const s = await setup();
    const { outcome } = await extractedBinaryOutcome(s);
    await grade.generateDraft(ctx(s.statistician.id), s.project.id, outcome.id, {});
    const run = await prisma.aiGradeRun.create({
      data: {
        projectId: s.project.id,
        analysisOutcomeId: outcome.id,
        status: "COMPLETED",
        provider: "fake",
        model: "fake-model-1",
        promptVersion: "grade-v2",
        totalDomains: 5,
        requestedById: s.statistician.id,
      },
    });
    const suggestion = await prisma.gradeDomainSuggestion.create({
      data: {
        runId: run.id,
        analysisOutcomeId: outcome.id,
        domain: "IMPRECISION",
        suggestedJudgment: "NOT_SERIOUS",
        rationale: "Prompt-neutral lifecycle regression.",
        provider: "fake",
        model: "fake-model-1",
        promptVersion: "grade-v2",
      },
    });

    await grade.setStartingLevel(ctx(s.statistician.id), s.project.id, outcome.id, {
      startingLevel: "LOW",
    });
    let view = await grade.getGradeView(ctx(s.statistician.id), s.project.id, outcome.id);
    expect(view.outOfDate).toBe(false);
    expect(view.suggestions.map((item) => item.id)).toEqual([suggestion.id]);

    await grade.markReviewed(ctx(s.statistician.id), s.project.id, outcome.id);
    view = await grade.getGradeView(ctx(s.statistician.id), s.project.id, outcome.id);
    expect(view.assessment!.status).toBe("REVIEWED");
    expect(view.suggestions.map((item) => item.id)).toEqual([suggestion.id]);
  });
});

describe("tenancy + permissions", () => {
  it("R9: a foreign project's outcome is invisible (404)", async () => {
    const s = await setup();
    const { outcome } = await extractedBinaryOutcome(s);
    const foreign = await createProjectWithTeam();
    const fctx = ctx(foreign.owner.id);
    await expectAppError(grade.getGradeView(fctx, foreign.project.id, outcome.id), "NOT_FOUND");
    await expectAppError(
      grade.generateDraft(fctx, foreign.project.id, outcome.id, {}),
      "NOT_FOUND",
    );
    await expectAppError(
      grade.updateDomainRating(fctx, foreign.project.id, outcome.id, "IMPRECISION", {
        judgment: "NOT_SERIOUS",
      }),
      "NOT_FOUND",
    );
    await expectAppError(
      grade.setStartingLevel(fctx, foreign.project.id, outcome.id, { startingLevel: "LOW" }),
      "NOT_FOUND",
    );
    await expectAppError(grade.markReviewed(fctx, foreign.project.id, outcome.id), "NOT_FOUND");
  });

  it("OBSERVER views but cannot manage; REVIEWER neither; STATISTICIAN manages", async () => {
    const s = await setup();
    const { outcome } = await extractedBinaryOutcome(s);
    // STATISTICIAN manages.
    await grade.generateDraft(ctx(s.statistician.id), s.project.id, outcome.id, {});

    // OBSERVER: analysis.view only.
    const view = await grade.getGradeView(ctx(s.observer.id), s.project.id, outcome.id);
    expect(view.assessment).not.toBeNull();
    expect((await grade.computeSof(ctx(s.observer.id), s.project.id)).rows).toHaveLength(1);
    await expectAppError(
      grade.generateDraft(ctx(s.observer.id), s.project.id, outcome.id, {}),
      "FORBIDDEN",
    );
    await expectAppError(
      grade.updateDomainRating(ctx(s.observer.id), s.project.id, outcome.id, "IMPRECISION", {
        judgment: "NOT_SERIOUS",
      }),
      "FORBIDDEN",
    );
    await expectAppError(
      grade.setStartingLevel(ctx(s.observer.id), s.project.id, outcome.id, {
        startingLevel: "LOW",
      }),
      "FORBIDDEN",
    );
    await expectAppError(
      grade.markReviewed(ctx(s.observer.id), s.project.id, outcome.id),
      "FORBIDDEN",
    );

    // Plain REVIEWER holds neither capability.
    await expectAppError(
      grade.getGradeView(ctx(s.reviewer1.id), s.project.id, outcome.id),
      "FORBIDDEN",
    );
    await expectAppError(grade.computeSof(ctx(s.reviewer1.id), s.project.id), "FORBIDDEN");
  });

  it("keeps GRADE audit prose and actor identity behind analysis.view", async () => {
    const s = await setup();
    const { outcome } = await extractedBinaryOutcome(s);
    await grade.generateDraft(ctx(s.statistician.id), s.project.id, outcome.id, {});
    await grade.updateDomainRating(
      ctx(s.statistician.id),
      s.project.id,
      outcome.id,
      "INDIRECTNESS",
      { rationale: "Sensitive applicability rationale for the pooled outcome." },
    );

    // Both roles can open Audit, but neither can view Analysis.
    for (const caller of [s.reviewer1, s.librarian]) {
      const hidden = await listAuditEvents(ctx(caller.id), s.project.id, {
        actionPrefix: "grade.",
      });
      expect(hidden.events).toHaveLength(0);
    }

    // An analysis viewer may inspect the same final-tier audit trail.
    const visible = await listAuditEvents(ctx(s.observer.id), s.project.id, {
      actionPrefix: "grade.",
    });
    expect(visible.events.length).toBeGreaterThan(0);
    expect(JSON.stringify(visible.events)).toContain("Sensitive applicability rationale");
    expect(visible.events.some((event) => event.actor.id === s.statistician.id)).toBe(true);

    // Losing analysis.view also removes access to one's own historical GRADE events.
    await prisma.projectMember.update({
      where: { projectId_userId: { projectId: s.project.id, userId: s.statistician.id } },
      data: { roles: ["REVIEWER"] },
    });
    const formerEditor = await listAuditEvents(ctx(s.statistician.id), s.project.id, {
      actionPrefix: "grade.",
    });
    expect(formerEditor.events).toHaveLength(0);
  });
});

describe("RoB roll-up", () => {
  it("resolves adjudicated > consensus > single-with-withholding > derived-from-domains", async () => {
    const s = await setup();
    const tool = await makeRobTool(s);
    const [d1, d2] = tool.domains;

    const adjudicated = await s.makeStudy("Adjudicated");
    const differing = await s.makeStudy("Differing");
    const withheldInProgress = await s.makeStudy("Withheld in-progress");
    const withheldPending = await s.makeStudy("Withheld pending");
    const cleanSingle = await s.makeStudy("Clean single");
    const consensus = await s.makeStudy("Consensus");
    const derived = await s.makeStudy("Derived");

    // Adjudicated: differing votes + RESOLVED overall conflict -> the final judgment wins.
    await completeAssessment(tool.id, adjudicated.id, s.reviewer1.id, "low");
    await completeAssessment(tool.id, adjudicated.id, s.reviewer2.id, "high");
    await prisma.riskOfBiasConflict.create({
      data: {
        toolId: tool.id,
        studyId: adjudicated.id,
        domainId: null,
        status: "RESOLVED",
        resolvedAt: new Date(),
        adjudication: {
          create: {
            adjudicatorId: s.adjudicator.id,
            finalJudgment: "high",
            reason: "Attrition dominates.",
          },
        },
      },
    });
    // Differing without adjudication: unresolved — neither vote may leak.
    await completeAssessment(tool.id, differing.id, s.reviewer1.id, "low");
    await completeAssessment(tool.id, differing.id, s.reviewer2.id, "high");
    // Single completed vote withheld while a co-assessment is IN_PROGRESS...
    await completeAssessment(tool.id, withheldInProgress.id, s.reviewer1.id, "low");
    await prisma.riskOfBiasAssessment.create({
      data: {
        toolId: tool.id,
        studyId: withheldInProgress.id,
        assessorId: s.reviewer2.id,
        status: "IN_PROGRESS",
      },
    });
    // ...or while another assignment is still PENDING.
    await completeAssessment(tool.id, withheldPending.id, s.reviewer1.id, "low");
    await prisma.riskOfBiasAssignment.create({
      data: {
        toolId: tool.id,
        studyId: withheldPending.id,
        assessorId: s.reviewer2.id,
        status: "PENDING",
      },
    });
    // A lone completed vote with no open co-assessment resolves as "single".
    await completeAssessment(tool.id, cleanSingle.id, s.reviewer1.id, "low");
    // Two agreeing completed votes -> consensus.
    await completeAssessment(tool.id, consensus.id, s.reviewer1.id, "some_concerns");
    await completeAssessment(tool.id, consensus.id, s.reviewer2.id, "some_concerns");
    // No overall judgment anywhere -> derived from unanimous per-domain judgments,
    // taking the WORST domain bucket.
    for (const assessorId of [s.reviewer1.id, s.reviewer2.id]) {
      await completeAssessment(tool.id, derived.id, assessorId, null, [
        { domainId: d1!.id, judgment: "low" },
        { domainId: d2!.id, judgment: "some_concerns" },
      ]);
    }

    const studyIds = [
      adjudicated.id,
      differing.id,
      withheldInProgress.id,
      withheldPending.id,
      cleanSingle.id,
      consensus.id,
      derived.id,
    ];
    const resolved = await grade.resolveRobForStudies(prisma, s.project.id, studyIds);

    expect(resolved.get(adjudicated.id)).toMatchObject({
      judgment: "high",
      judgmentLabel: "High risk",
      bucket: "high",
      classificationCertain: true,
      provenance: "adjudicated",
      toolId: tool.id,
      toolName: "Test RoB Tool",
    });
    const unassessed = {
      judgment: null,
      judgmentLabel: null,
      bucket: "unassessed",
      classificationCertain: false,
      provenance: null,
      toolId: null,
      toolName: null,
    };
    expect(resolved.get(differing.id)).toEqual(unassessed);
    expect(resolved.get(withheldInProgress.id)).toEqual(unassessed);
    expect(resolved.get(withheldPending.id)).toEqual(unassessed);
    expect(resolved.get(cleanSingle.id)).toMatchObject({
      judgment: "low",
      bucket: "low",
      provenance: "single",
    });
    expect(resolved.get(consensus.id)).toMatchObject({
      judgment: "some_concerns",
      judgmentLabel: "Some concerns",
      bucket: "moderate",
      provenance: "consensus",
    });
    expect(resolved.get(derived.id)).toMatchObject({
      judgment: "some_concerns",
      bucket: "moderate",
      provenance: "derived-from-domains",
    });
  });

  it("propagates an uncertain custom-scale classification for human review", async () => {
    const s = await setup();
    const study = await s.makeStudy("Unranked custom scale");
    const tool = await prisma.riskOfBiasTool.create({
      data: {
        projectId: s.project.id,
        name: "Legacy confidence scale",
        judgmentScale: [
          { value: "high_confidence", label: "High confidence" },
          { value: "low_confidence", label: "Low confidence" },
        ],
        status: "PUBLISHED",
        createdById: s.owner.id,
      },
    });
    await completeAssessment(tool.id, study.id, s.reviewer1.id, "high_confidence");

    const resolved = await grade.resolveRobForStudies(prisma, s.project.id, [study.id]);
    expect(resolved.get(study.id)).toEqual({
      judgment: "high_confidence",
      judgmentLabel: "High confidence",
      bucket: "unclear",
      classificationCertain: false,
      provenance: "single",
      toolId: tool.id,
      toolName: "Legacy confidence scale",
    });
  });

  it("keeps derived RoB uncertain when any equally ranked domain is unclassifiable", async () => {
    const s = await setup();
    const study = await s.makeStudy("Derived uncertain scale");
    const tool = await prisma.riskOfBiasTool.create({
      data: {
        projectId: s.project.id,
        name: "Mixed unclear scale",
        judgmentScale: [
          { value: "unclear", label: "Unclear" },
          { value: "high_confidence", label: "High confidence" },
        ],
        status: "PUBLISHED",
        createdById: s.owner.id,
        domains: {
          create: [{ name: "Informational", order: 0 }, { name: "Unranked", order: 1 }],
        },
      },
      include: { domains: { orderBy: { order: "asc" } } },
    });
    const [informational, unranked] = tool.domains;
    for (const assessorId of [s.reviewer1.id, s.reviewer2.id]) {
      await completeAssessment(tool.id, study.id, assessorId, null, [
        { domainId: informational!.id, judgment: "unclear" },
        { domainId: unranked!.id, judgment: "high_confidence" },
      ]);
    }

    const resolved = await grade.resolveRobForStudies(prisma, s.project.id, [study.id]);
    expect(resolved.get(study.id)).toMatchObject({
      judgment: "unclear", // first tied bucket supplies display text
      bucket: "unclear",
      classificationCertain: false, // second domain remains review-required
      provenance: "derived-from-domains",
    });
  });
});

describe("computeSof", () => {
  it("returns rows with absolute effects, certainty and footnotes", async () => {
    const s = await setup();
    const { outcome, alpha, bravo } = await extractedBinaryOutcome(s);
    const tool = await makeRobTool(s);
    for (const study of [alpha, bravo]) {
      await completeAssessment(tool.id, study.id, s.reviewer1.id, "low");
      await completeAssessment(tool.id, study.id, s.reviewer2.id, "low");
    }
    await grade.generateDraft(ctx(s.statistician.id), s.project.id, outcome.id, {});

    const sof = await grade.computeSof(ctx(s.observer.id), s.project.id);
    expect(typeof sof.generatedAt).toBe("string");
    expect(sof.rows).toHaveLength(1);
    const row = sof.rows[0]!;
    expect(row).toMatchObject({
      outcomeId: outcome.id,
      name: "Responders",
      timepoint: "12 months",
      measure: "RR",
      model: "RANDOM",
      groupLabels: { g1: "Valve", g2: "Control" },
      k: 2,
      totalN: 287,
      proportionPer1000: null,
    });
    expect(row.relative!.estimate).toBeGreaterThan(2.8);
    expect(row.relative!.estimate).toBeLessThan(3.2);
    // Assumed risk = median comparator risk per 1000: mean of 10/62 and 6/50.
    expect(row.absolute!.assumedPer1000).toBeCloseTo(140.6452, 3);
    expect(row.absolute!.correspondingPer1000).toBeCloseTo(
      row.absolute!.assumedPer1000 * row.relative!.estimate,
      6,
    );
    expect(row.absolute!.correspondingCiLowPer1000).toBeCloseTo(
      row.absolute!.assumedPer1000 * row.relative!.ciLow,
      6,
    );
    expect(row.certainty).toMatchObject({
      level: "MODERATE",
      points: 3,
      status: "DRAFT",
      startingLevel: "HIGH",
      reviewedByName: null,
    });
    expect(row.footnotes).toHaveLength(3);
    expect(row.footnotes[0]).toMatch(/^Downgraded \(−1\) for imprecision:/);
    expect(row.footnotes[1]).toMatch(/^Review required — indirectness:/);
    expect(row.footnotes[2]).toMatch(/^Review required — publication bias:/);

    // Outcomes without an assessment still get a row (certainty null, no footnotes).
    const bare = await analysis.createOutcome(ctx(s.statistician.id), s.project.id, {
      name: "Bare outcome",
      measure: "MD",
    });
    const sof2 = await grade.computeSof(ctx(s.observer.id), s.project.id);
    expect(sof2.rows).toHaveLength(2);
    const bareRow = sof2.rows.find((r) => r.outcomeId === bare.id)!;
    expect(bareRow).toMatchObject({
      k: 0,
      totalN: null,
      relative: null,
      absolute: null,
      certainty: null,
      footnotes: [],
    });
  });
});

describe("deleteOutcome cascade", () => {
  it("removes suggestions, runs, ratings and the assessment with the outcome", async () => {
    const s = await setup();
    const { outcome } = await extractedBinaryOutcome(s);
    await grade.generateDraft(ctx(s.statistician.id), s.project.id, outcome.id, {});
    const run = await prisma.aiGradeRun.create({
      data: {
        projectId: s.project.id,
        analysisOutcomeId: outcome.id,
        status: "COMPLETED",
        provider: "fake",
        model: "fake-model-1",
        promptVersion: "grade-v1",
        totalDomains: 5,
        requestedById: s.statistician.id,
      },
    });
    await prisma.gradeDomainSuggestion.create({
      data: {
        runId: run.id,
        analysisOutcomeId: outcome.id,
        domain: "IMPRECISION",
        suggestedJudgment: "SERIOUS",
        rationale: "AI prose",
        provider: "fake",
        model: "fake-model-1",
        promptVersion: "grade-v1",
      },
    });

    await analysis.deleteOutcome(ctx(s.statistician.id), s.project.id, outcome.id);
    const where = { analysisOutcomeId: outcome.id };
    expect(await prisma.gradeDomainSuggestion.count({ where })).toBe(0);
    expect(await prisma.aiGradeRun.count({ where })).toBe(0);
    expect(await prisma.gradeAssessment.count({ where })).toBe(0);
    expect(await prisma.gradeDomainRating.count({ where: { assessment: where } })).toBe(0);
    expect(await prisma.analysisOutcome.count({ where: { id: outcome.id } })).toBe(0);
  });
});

describe("GRADE export", () => {
  it("mirrors the ANALYSIS capability gate and neutralizes CSV formula injection", async () => {
    const s = await setup();
    const { outcome, alpha, bravo } = await extractedBinaryOutcome(s);
    await grade.generateDraft(ctx(s.statistician.id), s.project.id, outcome.id, {});
    // A hostile rationale must come out neutralized in the CSV.
    await grade.updateDomainRating(ctx(s.statistician.id), s.project.id, outcome.id, "INDIRECTNESS", {
      rationale: "=2+2 injected",
    });

    // LIBRARIAN holds export.create but not analysis.view -> 403 at create AND download.
    await expectAppError(
      createExport(ctx(s.librarian.id), s.project.id, { kind: "GRADE", format: "JSON" }),
      "FORBIDDEN",
    );

    const csvJob = await createExport(ctx(s.statistician.id), s.project.id, {
      kind: "GRADE",
      format: "CSV",
    });
    await expectAppError(
      downloadExport(ctx(s.librarian.id), s.project.id, csvJob.id),
      "FORBIDDEN",
    );
    const csv = await downloadExport(ctx(s.statistician.id), s.project.id, csvJob.id);
    expect(csv.filename).toBe(`grade-${s.project.id}.csv`);
    expect(csv.body).toContain("sof_row");
    expect(csv.body).toContain("grade_rating");
    expect(csv.body).toContain("grade_assessment");
    expect(csv.body).toContain("'=2+2 injected"); // formula-injection guard
    expect(csv.body).not.toMatch(/[^']=2\+2 injected/);

    const jsonJob = await createExport(ctx(s.statistician.id), s.project.id, {
      kind: "GRADE",
      format: "JSON",
    });
    const json = await downloadExport(ctx(s.statistician.id), s.project.id, jsonJob.id);
    const body = JSON.parse(json.body) as {
      generatedAt: string;
      sof: { name: string; k: number; footnotes: string[]; certainty: { level: string } }[];
      assessments: { outcome: { name: string }; ratings: { domain: string }[] }[];
    };
    expect(body.sof).toHaveLength(1);
    expect(body.sof[0]).toMatchObject({ name: "Responders", k: 2 });
    expect(Array.isArray(body.sof[0]!.footnotes)).toBe(true);
    expect(body.assessments).toHaveLength(1);
    expect(body.assessments[0]!.ratings.map((r) => r.domain)).toEqual([
      "RISK_OF_BIAS",
      "INCONSISTENCY",
      "INDIRECTNESS",
      "IMPRECISION",
      "PUBLICATION_BIAS",
    ]);

    // If the pooled source later disappears, exports must not present the saved certainty
    // or REVIEWED/DRAFT lifecycle status as current.
    for (const study of [alpha, bravo]) {
      await analysis.setStudyExclusion(
        ctx(s.statistician.id),
        s.project.id,
        outcome.id,
        study.id,
        { excluded: true, reason: "Freshness regression" },
      );
    }
    const staleJob = await createExport(ctx(s.statistician.id), s.project.id, {
      kind: "GRADE",
      format: "JSON",
    });
    const staleDownload = await downloadExport(
      ctx(s.statistician.id),
      s.project.id,
      staleJob.id,
    );
    const staleBody = JSON.parse(staleDownload.body) as {
      sof: { certainty: { stale: boolean; sourceUnavailable: boolean } }[];
      assessments: {
        status: string;
        certaintyOutOfDate: boolean;
        sourceUnavailable: boolean;
      }[];
    };
    expect(staleBody.sof[0]!.certainty).toMatchObject({
      stale: true,
      sourceUnavailable: true,
    });
    expect(staleBody.assessments[0]).toMatchObject({
      status: "OUT_OF_DATE",
      certaintyOutOfDate: true,
      sourceUnavailable: true,
    });
  });
});
