// Analysis (meta-analysis) integration tests — outcome CRUD, mapping validation, R9
// tenancy, permissions, and end-to-end result computation driven by REAL extraction data
// flowing through the extraction services (dual completion -> consensus / conflict ->
// adjudication), including template-version lineage, provisional values, manual
// exclusions, and stats-engine rejections.
import { beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/server/db";
import { AppError } from "@/server/errors";
import * as analysis from "@/server/services/analysis";
import { scaffoldOutcomeFields } from "@/server/services/analysis/scaffold";
import * as extraction from "@/server/services/extraction";
import { createExport, downloadExport } from "@/server/services/exports";
import { resetDb } from "../db-utils";
import {
  addOrgMember,
  addProjectMember,
  createProjectWithTeam,
  createTestCitation,
  createTestUser,
} from "../factories";

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

const BINARY_FIELDS = [
  { key: "e1", label: "Events (intervention)", type: "NUMBER" as const },
  { key: "n1", label: "Total (intervention)", type: "NUMBER" as const },
  { key: "e2", label: "Events (control)", type: "NUMBER" as const },
  { key: "n2", label: "Total (control)", type: "NUMBER" as const },
  { key: "note", label: "Note", type: "TEXT" as const },
];

async function setup() {
  const team = await createProjectWithTeam();
  const statistician = await createTestUser({ name: "Stan Statistician" });
  const extractor1 = await createTestUser({ name: "Extractor One" });
  const extractor2 = await createTestUser({ name: "Extractor Two" });
  const adjudicator = await createTestUser({ name: "Ada Adjudicator" });
  const reviewer = await createTestUser({ name: "Plain Reviewer" });
  for (const u of [statistician, extractor1, extractor2, adjudicator, reviewer]) {
    await addOrgMember(team.org.id, u.id);
  }
  await addProjectMember(team.project.id, statistician.id, ["STATISTICIAN"]);
  await addProjectMember(team.project.id, extractor1.id, ["EXTRACTOR"]);
  await addProjectMember(team.project.id, extractor2.id, ["EXTRACTOR"]);
  await addProjectMember(team.project.id, adjudicator.id, ["ADJUDICATOR"]);
  await addProjectMember(team.project.id, reviewer.id, ["REVIEWER"]);

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
  const fieldByKey = new Map(template.fields.map((f) => [f.key, f]));

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
    adjudicator,
    reviewer,
    template,
    fieldByKey,
    makeStudy,
  };
}

type Setup = Awaited<ReturnType<typeof setup>>;

// Fills one extractor's form with the given per-key values and optionally completes it.
async function fillForm(
  s: Setup,
  studyId: string,
  extractorId: string,
  values: Record<string, number>,
  opts: { complete?: boolean; templateId?: string } = {},
) {
  const templateId = opts.templateId ?? s.template.id;
  const { form } = await extraction.startForm(ctx(extractorId), s.project.id, studyId, {
    templateId,
  });
  const fields = await prisma.extractionField.findMany({ where: { templateId } });
  const byKey = new Map(fields.map((f) => [f.key, f]));
  for (const [key, value] of Object.entries(values)) {
    await extraction.upsertValue(ctx(extractorId), s.project.id, form.id, byKey.get(key)!.id, {
      value,
    });
  }
  if (opts.complete !== false) {
    await extraction.completeForm(ctx(extractorId), s.project.id, form.id);
  }
  return form;
}

async function binaryOutcome(s: Setup, measure: "RR" | "OR" | "RD" = "RR") {
  const outcome = await analysis.createOutcome(ctx(s.statistician.id), s.project.id, {
    name: "Responders",
    measure,
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
  return outcome;
}

beforeAll(async () => {
  await resetDb();
});

describe("outcome CRUD + mappings", () => {
  it("creates, lists, updates, and deletes outcomes with audit + mapping completeness", async () => {
    const s = await setup();
    const outcome = await analysis.createOutcome(ctx(s.statistician.id), s.project.id, {
      name: "Responders",
      measure: "RR",
      timepoint: "12 months",
      direction: "HIGHER_IS_BETTER",
    });
    expect(outcome).toMatchObject({
      name: "Responders",
      measure: "RR",
      timepoint: "12 months",
      direction: "HIGHER_IS_BETTER",
      model: "RANDOM",
      mappingComplete: false,
    });
    expect(outcome.requiredRoles.sort()).toEqual(
      ["G1_EVENTS", "G1_TOTAL", "G2_EVENTS", "G2_TOTAL"].sort(),
    );

    await analysis.replaceMappings(ctx(s.statistician.id), s.project.id, outcome.id, {
      mappings: [
        { role: "G1_EVENTS", templateId: s.template.id, fieldKey: "e1" },
        { role: "G1_TOTAL", templateId: s.template.id, fieldKey: "n1" },
        { role: "G2_EVENTS", templateId: s.template.id, fieldKey: "e2" },
        { role: "G2_TOTAL", templateId: s.template.id, fieldKey: "n2" },
      ],
    });
    const listed = await analysis.listOutcomes(ctx(s.statistician.id), s.project.id);
    expect(listed).toHaveLength(1);
    expect(listed[0]!.mappingComplete).toBe(true);
    expect(listed[0]!.mappings).toHaveLength(4);

    const updated = await analysis.updateOutcome(ctx(s.statistician.id), s.project.id, outcome.id, {
      name: "Responders (renamed)",
      model: "FIXED",
    });
    expect(updated).toMatchObject({ name: "Responders (renamed)", model: "FIXED", measure: "RR" });

    const actions = await prisma.auditEvent.findMany({
      where: { projectId: s.project.id, action: { startsWith: "analysis." } },
      select: { action: true },
    });
    expect(actions.map((a) => a.action).sort()).toEqual([
      "analysis.mappings.replaced",
      "analysis.outcome.created",
      "analysis.outcome.updated",
    ]);

    await analysis.deleteOutcome(ctx(s.statistician.id), s.project.id, outcome.id);
    expect(await analysis.listOutcomes(ctx(s.statistician.id), s.project.id)).toHaveLength(0);
    // Children go with it.
    expect(await prisma.analysisFieldMap.count({ where: { analysisOutcomeId: outcome.id } })).toBe(0);
  });

  it("rejects invalid mappings: wrong role, non-NUMBER field, unknown key, foreign template", async () => {
    const s = await setup();
    const outcome = await analysis.createOutcome(ctx(s.statistician.id), s.project.id, {
      name: "Responders",
      measure: "RR",
    });
    const bad = (mappings: { role: string; templateId: string; fieldKey: string }[]) =>
      analysis.replaceMappings(ctx(s.statistician.id), s.project.id, outcome.id, {
        mappings: mappings as never,
      });

    // Continuous role on a binary measure.
    await expectAppError(
      bad([{ role: "G1_MEAN", templateId: s.template.id, fieldKey: "e1" }]),
      "VALIDATION",
    );
    // TEXT field cannot carry a number.
    await expectAppError(
      bad([{ role: "G1_EVENTS", templateId: s.template.id, fieldKey: "note" }]),
      "VALIDATION",
    );
    // Unknown field key.
    await expectAppError(
      bad([{ role: "G1_EVENTS", templateId: s.template.id, fieldKey: "nope" }]),
      "VALIDATION",
    );
    // R9: another project's template.
    const foreign = await createProjectWithTeam();
    const foreignTemplate = await prisma.extractionTemplate.create({
      data: {
        projectId: foreign.project.id,
        name: "Foreign",
        status: "PUBLISHED",
        createdById: foreign.owner.id,
      },
    });
    await expectAppError(
      bad([{ role: "G1_EVENTS", templateId: foreignTemplate.id, fieldKey: "e1" }]),
      "NOT_FOUND",
    );
  });

  it("enforces permissions and tenancy", async () => {
    const s = await setup();
    const outcome = await binaryOutcome(s);

    // EXTRACTOR holds neither analysis.view nor analysis.manage.
    await expectAppError(analysis.listOutcomes(ctx(s.extractor1.id), s.project.id), "FORBIDDEN");
    await expectAppError(
      analysis.computeOutcomeResults(ctx(s.extractor1.id), s.project.id, outcome.id),
      "FORBIDDEN",
    );
    // ADJUDICATOR: view yes, manage no.
    expect(await analysis.listOutcomes(ctx(s.adjudicator.id), s.project.id)).toHaveLength(1);
    await expectAppError(
      analysis.createOutcome(ctx(s.adjudicator.id), s.project.id, {
        name: "Nope",
        measure: "RR",
      }),
      "FORBIDDEN",
    );
    // Plain REVIEWER cannot see analysis at all.
    await expectAppError(analysis.listOutcomes(ctx(s.reviewer.id), s.project.id), "FORBIDDEN");

    // R9: another project's outcome id is invisible from this project.
    const foreign = await createProjectWithTeam();
    await expectAppError(
      analysis.computeOutcomeResults(ctx(s.owner.id), foreign.project.id, outcome.id),
      "FORBIDDEN", // owner of s.project is not a member of the foreign project
    );
    await expectAppError(
      analysis.getOutcome(ctx(foreign.owner.id), foreign.project.id, outcome.id),
      "NOT_FOUND",
    );
  });
});

describe("computeOutcomeResults", () => {
  it("pools consensus + adjudicated values and reports heterogeneity", async () => {
    const s = await setup();
    const studyA = await s.makeStudy("Alpha 2019");
    const studyB = await s.makeStudy("Bravo 2021");

    // Study A: both extractors agree exactly -> CONSENSUS on every role.
    for (const e of [s.extractor1.id, s.extractor2.id]) {
      await fillForm(s, studyA.id, e, { e1: 60, n1: 128, e2: 10, n2: 62 });
    }
    // Study B: disagreement on e1 -> conflict -> adjudicated to 18.
    await fillForm(s, studyB.id, s.extractor1.id, { e1: 18, n1: 47, e2: 6, n2: 50 });
    await fillForm(s, studyB.id, s.extractor2.id, { e1: 20, n1: 47, e2: 6, n2: 50 });

    const outcome = await binaryOutcome(s);

    // Before adjudication study B is disputed and cannot pool. Dispute detail is
    // seeAll-only (owner); a blinded statistician gets a generic unfinished row.
    const mid = await analysis.computeOutcomeResults(ctx(s.owner.id), s.project.id, outcome.id);
    const midB = mid.rows.find((r) => r.studyId === studyB.id)!;
    expect(midB.status).toBe("disputed");
    expect(midB.effect).toBeNull();
    expect(mid.rows.find((r) => r.studyId === studyA.id)!.status).toBe("included");
    const midBlind = await analysis.computeOutcomeResults(ctx(s.statistician.id), s.project.id, outcome.id);
    const midBlindB = midBlind.rows.find((r) => r.studyId === studyB.id)!;
    expect(midBlindB.status).toBe("incomplete");
    expect(midBlindB.reason).not.toMatch(/disagreement/i);

    const conflicts = await extraction.listConflicts(ctx(s.adjudicator.id), s.project.id, {
      status: "OPEN",
    });
    expect(conflicts).toHaveLength(1);
    await extraction.adjudicateConflict(ctx(s.adjudicator.id), s.project.id, conflicts[0]!.id, {
      finalValue: 18,
      reason: "CONSORT diagram reports 18 responders.",
    });

    const results = await analysis.computeOutcomeResults(
      ctx(s.statistician.id),
      s.project.id,
      outcome.id,
    );
    expect(results.scale).toBe("log");
    expect(results.nullValue).toBe(1);
    expect(results.groupLabels).toEqual({ g1: "Valve", g2: "Control" });

    const rowA = results.rows.find((r) => r.studyId === studyA.id)!;
    const rowB = results.rows.find((r) => r.studyId === studyB.id)!;
    expect(rowA.status).toBe("included");
    expect(rowB.status).toBe("included");
    expect(rowA.values.G1_EVENTS).toEqual({ value: 60, source: "CONSENSUS" });
    expect(rowB.values.G1_EVENTS).toEqual({ value: 18, source: "ADJUDICATED" });
    expect(rowB.values.G2_EVENTS).toEqual({ value: 6, source: "CONSENSUS" });

    // Study A: RR = (60/128)/(10/62) = 2.906...
    expect(rowA.effect!.display.estimate).toBeCloseTo(2.90625, 4);
    expect(rowA.effect!.display.ciLow).toBeLessThan(rowA.effect!.display.estimate);
    expect(rowA.effect!.weightRandomPct).toBeGreaterThan(0);

    // Study B: RR = (18/47)/(6/50) = 3.191...
    expect(rowB.effect!.display.estimate).toBeCloseTo(3.1914893617, 6);

    expect(results.pooled.random).not.toBeNull();
    expect(results.pooled.fixed).not.toBeNull();
    // Both studies favour the valve arm; pooled RR sits between the two study estimates.
    expect(results.pooled.random!.display.estimate).toBeGreaterThan(2.5);
    expect(results.pooled.random!.display.estimate).toBeLessThan(3.5);
    expect(results.pooled.random!.p).toBeLessThan(0.001);
    expect(results.heterogeneity).not.toBeNull();
    expect(results.heterogeneity!.df).toBe(1);
    expect(results.heterogeneity!.i2).toBeGreaterThanOrEqual(0);
    // Consistent estimates -> no heterogeneity -> DL tau2 collapses to 0.
    expect(results.heterogeneity!.tau2).toBe(0);

    const pooledWeight = results.rows
      .filter((r) => r.effect)
      .reduce((sum, r) => sum + r.effect!.weightRandomPct, 0);
    expect(pooledWeight).toBeCloseTo(100, 6);
  });

  it("classifies incomplete, provisional, excluded, and stats-rejected rows", async () => {
    const s = await setup();
    const complete = await s.makeStudy("Complete 2020");
    const partial = await s.makeStudy("Partial 2020");
    const inProgress = await s.makeStudy("InProgress 2020");
    const doubleZero = await s.makeStudy("DoubleZero 2020");
    const excluded = await s.makeStudy("Excluded 2020");

    await fillForm(s, complete.id, s.extractor1.id, { e1: 30, n1: 60, e2: 15, n2: 60 });
    // Missing e2/n2 -> incomplete.
    await fillForm(s, partial.id, s.extractor1.id, { e1: 10, n1: 40 });
    // Not completed -> only visible with includeProvisional.
    await fillForm(s, inProgress.id, s.extractor1.id, { e1: 12, n1: 40, e2: 8, n2: 41 }, { complete: false });
    // No events in either arm -> the stats engine rejects it for RR.
    await fillForm(s, doubleZero.id, s.extractor1.id, { e1: 0, n1: 30, e2: 0, n2: 31 });
    await fillForm(s, excluded.id, s.extractor1.id, { e1: 5, n1: 20, e2: 4, n2: 22 });

    const outcome = await binaryOutcome(s);
    await analysis.setStudyExclusion(ctx(s.statistician.id), s.project.id, outcome.id, excluded.id, {
      excluded: true,
      reason: "Population does not match the protocol.",
    });

    // Owner (seeAll) — pre-consensus SINGLE values and provisional mode are in play here.
    const base = await analysis.computeOutcomeResults(ctx(s.owner.id), s.project.id, outcome.id);
    const byId = new Map(base.rows.map((r) => [r.studyId, r]));
    expect(byId.get(complete.id)!.status).toBe("included");
    expect(byId.get(complete.id)!.values.G1_EVENTS).toEqual({ value: 30, source: "SINGLE" });
    expect(byId.get(partial.id)!.status).toBe("incomplete");
    expect(byId.get(inProgress.id)!.status).toBe("incomplete"); // in-progress hidden by default
    expect(byId.get(doubleZero.id)!.status).toBe("not-pooled");
    expect(byId.get(doubleZero.id)!.reason).toMatch(/zero/i);
    expect(byId.get(excluded.id)!.status).toBe("excluded");
    expect(byId.get(excluded.id)!.reason).toBe("Population does not match the protocol.");
    expect(byId.get(excluded.id)!.effect).toBeNull();

    // Provisional mode surfaces the in-progress study and pools it (seeAll callers only).
    const prov = await analysis.computeOutcomeResults(ctx(s.owner.id), s.project.id, outcome.id, {
      includeProvisional: true,
    });
    const provRow = prov.rows.find((r) => r.studyId === inProgress.id)!;
    expect(provRow.status).toBe("provisional");
    expect(provRow.values.G1_EVENTS).toEqual({ value: 12, source: "PROVISIONAL" });
    expect(provRow.effect).not.toBeNull();

    // Re-including the excluded study restores it.
    await analysis.setStudyExclusion(ctx(s.statistician.id), s.project.id, outcome.id, excluded.id, {
      excluded: false,
    });
    const after = await analysis.computeOutcomeResults(ctx(s.owner.id), s.project.id, outcome.id);
    expect(after.rows.find((r) => r.studyId === excluded.id)!.status).toBe("included");
  });

  it("resolves values across a template version lineage", async () => {
    const s = await setup();
    const study = await s.makeStudy("Lineage 2020");
    // Extracted against v1.
    await fillForm(s, study.id, s.extractor1.id, { e1: 25, n1: 50, e2: 12, n2: 48 });

    // New version of the template (v2) — same field keys, new field ids.
    const v2 = await extraction.createNewVersion(ctx(s.owner.id), s.project.id, s.template.id);
    await extraction.publishTemplate(ctx(s.owner.id), s.project.id, v2.id);

    // Map against v2; the v1 form's values must still resolve through the lineage.
    const outcome = await analysis.createOutcome(ctx(s.statistician.id), s.project.id, {
      name: "Responders",
      measure: "RR",
    });
    await analysis.replaceMappings(ctx(s.statistician.id), s.project.id, outcome.id, {
      mappings: [
        { role: "G1_EVENTS", templateId: v2.id, fieldKey: "e1" },
        { role: "G1_TOTAL", templateId: v2.id, fieldKey: "n1" },
        { role: "G2_EVENTS", templateId: v2.id, fieldKey: "e2" },
        { role: "G2_TOTAL", templateId: v2.id, fieldKey: "n2" },
      ],
    });

    // Owner: extractor2's assignment is still pending, so the SINGLE value is
    // seeAll-only until that co-extraction settles.
    const results = await analysis.computeOutcomeResults(
      ctx(s.owner.id),
      s.project.id,
      outcome.id,
    );
    const row = results.rows.find((r) => r.studyId === study.id)!;
    expect(row.status).toBe("included");
    expect(row.values.G1_EVENTS).toEqual({ value: 25, source: "SINGLE" });
    // RR = (25/50)/(12/48) = 2.0
    expect(row.effect!.display.estimate).toBeCloseTo(2, 10);
  });

  it("computes continuous measures (MD) from mapped mean/sd/n fields", async () => {
    const s = await setup();
    const template = await prisma.extractionTemplate.create({
      data: {
        projectId: s.project.id,
        name: "Continuous form",
        status: "PUBLISHED",
        createdById: s.owner.id,
        fields: {
          create: [
            { key: "m1", label: "Mean 1", type: "NUMBER", order: 0 },
            { key: "sd1", label: "SD 1", type: "NUMBER", order: 1 },
            { key: "cn1", label: "N 1", type: "NUMBER", order: 2 },
            { key: "m2", label: "Mean 2", type: "NUMBER", order: 3 },
            { key: "sd2", label: "SD 2", type: "NUMBER", order: 4 },
            { key: "cn2", label: "N 2", type: "NUMBER", order: 5 },
          ],
        },
      },
    });
    const study = await s.makeStudy("Continuous 2020");
    await prisma.extractionAssignment.create({
      data: { templateId: template.id, studyId: study.id, extractorId: s.extractor1.id },
    });
    await fillForm(
      s,
      study.id,
      s.extractor1.id,
      { m1: 12, sd1: 4, cn1: 40, m2: 9, sd2: 5, cn2: 42 },
      { templateId: template.id },
    );

    const outcome = await analysis.createOutcome(ctx(s.statistician.id), s.project.id, {
      name: "FEV1 change",
      measure: "MD",
    });
    expect(outcome.requiredRoles.sort()).toEqual(
      ["G1_MEAN", "G1_N", "G1_SD", "G2_MEAN", "G2_N", "G2_SD"].sort(),
    );
    await analysis.replaceMappings(ctx(s.statistician.id), s.project.id, outcome.id, {
      mappings: [
        { role: "G1_MEAN", templateId: template.id, fieldKey: "m1" },
        { role: "G1_SD", templateId: template.id, fieldKey: "sd1" },
        { role: "G1_N", templateId: template.id, fieldKey: "cn1" },
        { role: "G2_MEAN", templateId: template.id, fieldKey: "m2" },
        { role: "G2_SD", templateId: template.id, fieldKey: "sd2" },
        { role: "G2_N", templateId: template.id, fieldKey: "cn2" },
      ],
    });

    const results = await analysis.computeOutcomeResults(
      ctx(s.statistician.id),
      s.project.id,
      outcome.id,
    );
    expect(results.scale).toBe("linear");
    expect(results.nullValue).toBe(0);
    const row = results.rows.find((r) => r.studyId === study.id)!;
    expect(row.status).toBe("included");
    // MD = 12 - 9 = 3; SE = sqrt(16/40 + 25/42) = 0.9977...
    expect(row.effect!.display.estimate).toBeCloseTo(3, 10);
    expect(row.effect!.se).toBeCloseTo(Math.sqrt(16 / 40 + 25 / 42), 10);
  });

  it("returns an empty analysis when nothing pools", async () => {
    const s = await setup();
    await s.makeStudy("No data 2020");
    const outcome = await binaryOutcome(s);
    const results = await analysis.computeOutcomeResults(
      ctx(s.statistician.id),
      s.project.id,
      outcome.id,
    );
    expect(results.rows).toHaveLength(1);
    expect(results.rows[0]!.status).toBe("incomplete");
    expect(results.pooled.fixed).toBeNull();
    expect(results.pooled.random).toBeNull();
    expect(results.heterogeneity).toBeNull();
  });
});

// Publishes a new template version and re-assigns both extractors to it.
async function newVersionWithAssignments(s: Setup, studyIds: string[]) {
  const v2 = await extraction.createNewVersion(ctx(s.owner.id), s.project.id, s.template.id);
  await extraction.publishTemplate(ctx(s.owner.id), s.project.id, v2.id);
  await prisma.extractionAssignment.createMany({
    data: studyIds.flatMap((studyId) =>
      [s.extractor1.id, s.extractor2.id].map((extractorId) => ({
        templateId: v2.id,
        studyId,
        extractorId,
      })),
    ),
  });
  return v2;
}

async function binaryOutcomeOn(s: Setup, templateId: string) {
  const outcome = await analysis.createOutcome(ctx(s.statistician.id), s.project.id, {
    name: "Responders",
    measure: "RR",
  });
  await analysis.replaceMappings(ctx(s.statistician.id), s.project.id, outcome.id, {
    mappings: [
      { role: "G1_EVENTS", templateId, fieldKey: "e1" },
      { role: "G1_TOTAL", templateId, fieldKey: "n1" },
      { role: "G2_EVENTS", templateId, fieldKey: "e2" },
      { role: "G2_TOTAL", templateId, fieldKey: "n2" },
    ],
  });
  return outcome;
}

describe("template version precedence", () => {
  it("re-extraction on a newer version supersedes older values instead of disputing them", async () => {
    const s = await setup();
    const study = await s.makeStudy("Reextracted 2020");
    // v1: both extractors agree on 5.
    for (const e of [s.extractor1.id, s.extractor2.id]) {
      await fillForm(s, study.id, e, { e1: 5, n1: 50, e2: 10, n2: 50 });
    }
    // v2: both re-extract the corrected value 7.
    const v2 = await newVersionWithAssignments(s, [study.id]);
    for (const e of [s.extractor1.id, s.extractor2.id]) {
      await fillForm(s, study.id, e, { e1: 7, n1: 50, e2: 10, n2: 50 }, { templateId: v2.id });
    }

    const outcome = await binaryOutcomeOn(s, v2.id);
    const results = await analysis.computeOutcomeResults(ctx(s.owner.id), s.project.id, outcome.id);
    const row = results.rows.find((r) => r.studyId === study.id)!;
    // Flat-pooling across versions would call [5,5,7,7] an unresolvable dispute.
    expect(row.status).toBe("included");
    expect(row.values.G1_EVENTS).toEqual({ value: 7, source: "CONSENSUS" });
  });

  it("a newer version's consensus beats a stale adjudication, and a stale OPEN conflict cannot block it", async () => {
    const s = await setup();
    const adjudicated = await s.makeStudy("StaleAdjudication 2020");
    const blocked = await s.makeStudy("StaleOpenConflict 2020");

    // v1: both studies disagree on e1 -> two OPEN conflicts; resolve only the first.
    for (const [study, v1, v2] of [
      [adjudicated.id, 18, 20],
      [blocked.id, 18, 20],
    ] as const) {
      await fillForm(s, study, s.extractor1.id, { e1: v1, n1: 47, e2: 6, n2: 50 });
      await fillForm(s, study, s.extractor2.id, { e1: v2, n1: 47, e2: 6, n2: 50 });
    }
    const conflicts = await extraction.listConflicts(ctx(s.adjudicator.id), s.project.id, {
      status: "OPEN",
    });
    const first = conflicts.find((c) => c.studyId === adjudicated.id)!;
    await extraction.adjudicateConflict(ctx(s.adjudicator.id), s.project.id, first.id, {
      finalValue: 18,
      reason: "Original CONSORT count.",
    });

    // v2: both extractors re-extract 25 on both studies (clean consensus).
    const v2 = await newVersionWithAssignments(s, [adjudicated.id, blocked.id]);
    for (const study of [adjudicated.id, blocked.id]) {
      for (const e of [s.extractor1.id, s.extractor2.id]) {
        await fillForm(s, study, e, { e1: 25, n1: 47, e2: 6, n2: 50 }, { templateId: v2.id });
      }
    }

    const outcome = await binaryOutcomeOn(s, v2.id);
    const results = await analysis.computeOutcomeResults(ctx(s.owner.id), s.project.id, outcome.id);
    const rowAdj = results.rows.find((r) => r.studyId === adjudicated.id)!;
    const rowBlocked = results.rows.find((r) => r.studyId === blocked.id)!;
    // The superseded v1 adjudication (18) must not shadow the v2 consensus (25).
    expect(rowAdj.status).toBe("included");
    expect(rowAdj.values.G1_EVENTS).toEqual({ value: 25, source: "CONSENSUS" });
    // The still-OPEN v1 conflict must not mark the cleanly re-extracted study disputed.
    expect(rowBlocked.status).toBe("included");
    expect(rowBlocked.values.G1_EVENTS).toEqual({ value: 25, source: "CONSENSUS" });
  });

  it("one extractor completing two versions stays SINGLE, not a self-consensus", async () => {
    const s = await setup();
    const study = await s.makeStudy("SoloAcrossVersions 2020");
    await fillForm(s, study.id, s.extractor1.id, { e1: 9, n1: 30, e2: 4, n2: 31 });
    const v2 = await newVersionWithAssignments(s, [study.id]);
    await fillForm(s, study.id, s.extractor1.id, { e1: 9, n1: 30, e2: 4, n2: 31 }, { templateId: v2.id });

    const outcome = await binaryOutcomeOn(s, v2.id);
    const results = await analysis.computeOutcomeResults(ctx(s.owner.id), s.project.id, outcome.id);
    const row = results.rows.find((r) => r.studyId === study.id)!;
    expect(row.values.G1_EVENTS).toEqual({ value: 9, source: "SINGLE" });
  });
});

describe("analysis blinding (R1 mirror)", () => {
  it("withholds pre-consensus and provisional data from non-seeAll callers", async () => {
    const s = await setup();
    const single = await s.makeStudy("SinglePending 2020");
    const disputed = await s.makeStudy("Disputed 2020");
    const inProgress = await s.makeStudy("InProgress 2020");

    // single: one completed form, co-extractor still pending.
    await fillForm(s, single.id, s.extractor1.id, { e1: 30, n1: 60, e2: 15, n2: 60 });
    // disputed: completed disagreement -> OPEN conflict.
    await fillForm(s, disputed.id, s.extractor1.id, { e1: 18, n1: 47, e2: 6, n2: 50 });
    await fillForm(s, disputed.id, s.extractor2.id, { e1: 20, n1: 47, e2: 6, n2: 50 });
    // inProgress: values entered but the form is not completed.
    await fillForm(s, inProgress.id, s.extractor1.id, { e1: 12, n1: 40, e2: 8, n2: 41 }, { complete: false });

    const outcome = await binaryOutcome(s);

    // The statistician (analysis.view, no adjudicate/project.edit) asks for provisional
    // data — the server must refuse all pre-consensus detail.
    const blind = await analysis.computeOutcomeResults(ctx(s.statistician.id), s.project.id, outcome.id, {
      includeProvisional: true,
    });
    expect(blind.provisionalAllowed).toBe(false);
    const blindById = new Map(blind.rows.map((r) => [r.studyId, r]));
    // Lone completed value withheld while the co-extraction is open.
    expect(blindById.get(single.id)!.status).toBe("incomplete");
    expect(blindById.get(single.id)!.values.G1_EVENTS).toEqual({ value: null, source: null });
    // Dispute existence hidden behind a generic unfinished row.
    expect(blindById.get(disputed.id)!.status).toBe("incomplete");
    expect(blindById.get(disputed.id)!.reason).not.toMatch(/disagreement/i);
    // provisional=1 ignored: no provisional value leaks from the in-progress form.
    expect(blindById.get(inProgress.id)!.status).toBe("incomplete");
    const sources = blind.rows.flatMap((r) => Object.values(r.values).map((v) => v.source));
    expect(sources).not.toContain("PROVISIONAL");
    expect(sources).not.toContain("SINGLE");

    // A seeAll caller (owner) sees everything the old way.
    const open = await analysis.computeOutcomeResults(ctx(s.owner.id), s.project.id, outcome.id, {
      includeProvisional: true,
    });
    expect(open.provisionalAllowed).toBe(true);
    const openById = new Map(open.rows.map((r) => [r.studyId, r]));
    expect(openById.get(single.id)!.values.G1_EVENTS).toEqual({ value: 30, source: "SINGLE" });
    expect(openById.get(disputed.id)!.status).toBe("disputed");
    expect(openById.get(inProgress.id)!.values.G1_EVENTS).toEqual({ value: 12, source: "PROVISIONAL" });
  });

  it("shows SINGLE values to blinded callers once no co-extraction is open", async () => {
    const s = await setup();
    // A study assigned to exactly one extractor — single extraction is the final word.
    const citation = await createTestCitation(s.project.id);
    const study = await prisma.study.create({
      data: {
        projectId: s.project.id,
        label: "SoloExtraction 2020",
        createdById: s.owner.id,
        reportLinks: { create: { citationId: citation.id, isPrimaryReport: true } },
      },
    });
    await prisma.extractionAssignment.create({
      data: { templateId: s.template.id, studyId: study.id, extractorId: s.extractor1.id },
    });
    await fillForm(s, study.id, s.extractor1.id, { e1: 30, n1: 60, e2: 15, n2: 60 });

    const outcome = await binaryOutcome(s);
    const results = await analysis.computeOutcomeResults(ctx(s.statistician.id), s.project.id, outcome.id);
    const row = results.rows.find((r) => r.studyId === study.id)!;
    expect(row.status).toBe("included");
    expect(row.values.G1_EVENTS).toEqual({ value: 30, source: "SINGLE" });
  });

  it("uses caller-independent final-only resolution for shared outputs", async () => {
    const s = await setup();
    const study = await s.makeStudy("FinalOnly 2020");
    await fillForm(s, study.id, s.extractor1.id, { e1: 30, n1: 60, e2: 15, n2: 60 });
    const outcome = await binaryOutcome(s);

    // Ordinary analysis remains requester-relative: OWNER may inspect the completed
    // extractor's SINGLE values while the co-extractor assignment is still pending.
    const ordinary = await analysis.computeOutcomeResults(
      ctx(s.owner.id),
      s.project.id,
      outcome.id,
    );
    const ordinaryRow = ordinary.rows.find((r) => r.studyId === study.id)!;
    expect(ordinary.provisionalAllowed).toBe(true);
    expect(ordinaryRow.status).toBe("included");
    expect(ordinaryRow.values.G1_EVENTS).toEqual({ value: 30, source: "SINGLE" });

    // Shared GRADE/SoF computation must be caller-independent. Even for OWNER, finalOnly
    // disables provisional data and withholds that SINGLE while lineage work is open.
    const withheld = await analysis.computeOutcomeResults(
      ctx(s.owner.id),
      s.project.id,
      outcome.id,
      { includeProvisional: true, finalOnly: true },
    );
    const withheldRow = withheld.rows.find((r) => r.studyId === study.id)!;
    expect(withheld.provisionalAllowed).toBe(false);
    expect(withheldRow.status).toBe("incomplete");
    expect(withheldRow.values.G1_EVENTS).toEqual({ value: null, source: null });
    expect(withheld.pooled.random).toBeNull();

    // Once co-extraction finishes in agreement, the same final-only call sees consensus.
    await fillForm(s, study.id, s.extractor2.id, { e1: 30, n1: 60, e2: 15, n2: 60 });
    const finalized = await analysis.computeOutcomeResults(
      ctx(s.owner.id),
      s.project.id,
      outcome.id,
      { finalOnly: true },
    );
    const finalizedRow = finalized.rows.find((r) => r.studyId === study.id)!;
    expect(finalized.provisionalAllowed).toBe(false);
    expect(finalizedRow.status).toBe("included");
    expect(finalizedRow.values.G1_EVENTS).toEqual({ value: 30, source: "CONSENSUS" });
    expect(finalized.pooled.random).not.toBeNull();
  });

  it("orders studies with equal labels deterministically by id", async () => {
    const s = await setup();
    await s.makeStudy("Same Label 2020");
    await s.makeStudy("Same Label 2020");
    const outcome = await binaryOutcome(s);

    const results = await analysis.computeOutcomeResults(ctx(s.owner.id), s.project.id, outcome.id);
    const ids = results.rows.map((row) => row.studyId);
    expect(ids).toEqual([...ids].sort());
  });
});

describe("mapping guards + audit detail", () => {
  it("rejects mappings onto draft templates", async () => {
    const s = await setup();
    const draft = await prisma.extractionTemplate.create({
      data: {
        projectId: s.project.id,
        name: "Draft form",
        status: "DRAFT",
        createdById: s.owner.id,
        fields: { create: [{ key: "e1", label: "Events", type: "NUMBER", order: 0 }] },
      },
    });
    const outcome = await analysis.createOutcome(ctx(s.statistician.id), s.project.id, {
      name: "Responders",
      measure: "RR",
    });
    await expectAppError(
      analysis.replaceMappings(ctx(s.statistician.id), s.project.id, outcome.id, {
        mappings: [{ role: "G1_EVENTS", templateId: draft.id, fieldKey: "e1" }],
      }),
      "VALIDATION",
    );
  });

  it("audits mappings with their template coordinate", async () => {
    const s = await setup();
    const outcome = await binaryOutcome(s);
    const event = await prisma.auditEvent.findFirst({
      where: {
        projectId: s.project.id,
        entityId: outcome.id,
        action: "analysis.mappings.replaced",
      },
      orderBy: { createdAt: "desc" },
    });
    const next = event!.newValue as { mappings: Record<string, { templateId: string; fieldKey: string }> };
    expect(next.mappings.G1_EVENTS).toEqual({ templateId: s.template.id, fieldKey: "e1" });
  });
});

// ---------------------------------------------------------------------------
// Phase B measures (PROPORTION / GENERIC_IV)
// ---------------------------------------------------------------------------
// Expected numbers below were hand-computed with an independent Python/scipy
// session using the pinned formulas (logit/FT transforms, DL pooling, PI with
// t.ppf(0.975, k-2), CI-derived SE = (up-low)/(2*1.959963984540054)).

describe("phase B measures", () => {
  it("pools a single-arm proportion (logit), then re-pools live under Freeman–Tukey", async () => {
    const s = await setup();
    const a = await s.makeStudy("PropA 2020"); // 12/80
    const b = await s.makeStudy("PropB 2020"); // 0/45 — zero events (logit continuity)
    const c = await s.makeStudy("PropC 2020"); // 30/60
    await fillForm(s, a.id, s.extractor1.id, { e1: 12, n1: 80 });
    await fillForm(s, b.id, s.extractor1.id, { e1: 0, n1: 45 });
    await fillForm(s, c.id, s.extractor1.id, { e1: 30, n1: 60 });

    const outcome = await analysis.createOutcome(ctx(s.statistician.id), s.project.id, {
      name: "Complication rate",
      measure: "PROPORTION",
    });
    expect(outcome.requiredRoles).toEqual(["G1_EVENTS", "G1_TOTAL"]);
    expect(outcome.proportionTransform).toBe("LOGIT");
    await analysis.replaceMappings(ctx(s.statistician.id), s.project.id, outcome.id, {
      mappings: [
        { role: "G1_EVENTS", templateId: s.template.id, fieldKey: "e1" },
        { role: "G1_TOTAL", templateId: s.template.id, fieldKey: "n1" },
      ],
    });

    // Logit: y = ln(e/(n-e)); continuity (e+0.5, n+1) only at the boundaries.
    const logitRes = await analysis.computeOutcomeResults(ctx(s.owner.id), s.project.id, outcome.id);
    expect(logitRes.scale).toBe("logit");
    expect(logitRes.nullValue).toBeNull(); // no meaningful null line, single arm
    expect(logitRes.groupLabels.g1).toBe("Cohort");
    expect(logitRes.displayMeta).toEqual({ transform: "invlogit", harmonicN: null });
    const byId = new Map(logitRes.rows.map((r) => [r.studyId, r]));
    const rowA = byId.get(a.id)!;
    expect(rowA.status).toBe("included");
    expect(rowA.effect!.y).toBeCloseTo(-1.7346010553881064, 10); // ln(12/68)
    expect(rowA.effect!.se).toBeCloseTo(0.3131121455425747, 10); // sqrt(1/12 + 1/68)
    expect(rowA.effect!.display.estimate).toBeCloseTo(0.15, 10); // invlogit recovers e/n
    const rowB = byId.get(b.id)!;
    expect(rowB.effect!.y).toBeCloseTo(-4.51085950651685, 8); // ln(0.5/45.5)
    expect(rowB.effect!.display.estimate).toBeCloseTo(0.010869565217391308, 8); // 0.5/46
    expect(byId.get(c.id)!.effect!.display.estimate).toBeCloseTo(0.5, 10);
    expect(logitRes.pooled.random!.y).toBeCloseTo(-1.5829108387569473, 8);
    expect(logitRes.pooled.random!.display.estimate).toBeCloseTo(0.17038363122405822, 8);
    expect(logitRes.pooled.fixed!.y).toBeCloseTo(-0.7754108625249442, 8);
    expect(logitRes.heterogeneity!.tau2).toBeCloseTo(1.8094529077127375, 8);
    // k = 3 -> prediction interval + Egger both present.
    expect(logitRes.predictionInterval!.low).toBeCloseTo(-21.94468635130571, 6);
    expect(logitRes.predictionInterval!.high).toBeCloseTo(18.778864673791812, 6);
    expect(logitRes.egger).not.toBeNull();
    expect(logitRes.egger!.k).toBe(3);

    // Switching the transform is a live re-pool — no stored results anywhere.
    const updated = await analysis.updateOutcome(ctx(s.statistician.id), s.project.id, outcome.id, {
      proportionTransform: "FREEMAN_TUKEY",
    });
    expect(updated.proportionTransform).toBe("FREEMAN_TUKEY");
    const ft = await analysis.computeOutcomeResults(ctx(s.owner.id), s.project.id, outcome.id);
    expect(ft.scale).toBe("ft");
    expect(ft.displayMeta.transform).toBe("ft");
    expect(ft.displayMeta.harmonicN).toBeCloseTo(58.37837837837838, 8); // 3 / (1/80 + 1/45 + 1/60)
    const ftById = new Map(ft.rows.map((r) => [r.studyId, r]));
    // Per-study Miller back-transform uses that study's OWN n.
    expect(ftById.get(a.id)!.effect!.y).toBeCloseTo(0.40364480269554726, 10);
    expect(ftById.get(a.id)!.effect!.se).toBeCloseTo(0.05572782125753528, 10); // sqrt(1/(4n+2))
    expect(ftById.get(a.id)!.effect!.display.estimate).toBeCloseTo(0.15, 6);
    expect(ftById.get(b.id)!.effect!.display.estimate).toBeCloseTo(0, 6); // zero-event floor
    // Pooled back-transform uses the harmonic mean of the included n's.
    expect(ft.pooled.random!.y).toBeCloseTo(0.4223632326473661, 8);
    expect(ft.pooled.random!.display.estimate).toBeCloseTo(0.16243122657920395, 8);
    expect(ft.pooled.fixed!.display.estimate).toBeCloseTo(0.1816079006804565, 8);
  });

  it("computes generic inverse variance with CI-derived SEs and se-source completeness", async () => {
    const s = await setup();
    const template = await prisma.extractionTemplate.create({
      data: {
        projectId: s.project.id,
        name: "Effect estimates",
        status: "PUBLISHED",
        createdById: s.owner.id,
        fields: {
          create: [
            { key: "est", label: "Estimate", type: "NUMBER", order: 0 },
            { key: "sev", label: "SE", type: "NUMBER", order: 1 },
            { key: "cil", label: "CI low", type: "NUMBER", order: 2 },
            { key: "ciu", label: "CI high", type: "NUMBER", order: 3 },
          ],
        },
      },
    });
    const mk = async (label: string, values: Record<string, number>) => {
      const study = await s.makeStudy(label);
      await prisma.extractionAssignment.create({
        data: { templateId: template.id, studyId: study.id, extractorId: s.extractor1.id },
      });
      await fillForm(s, study.id, s.extractor1.id, values, { templateId: template.id });
      return study;
    };
    const g1 = await mk("Gen1 2020", { est: 0.25, cil: 0.02, ciu: 0.48 });
    const g2 = await mk("Gen2 2020", { est: -0.1, cil: -0.45, ciu: 0.25 });
    const g3 = await mk("Gen3 2020", { est: 0.4, cil: 0.11, ciu: 0.69 });
    const bad = await mk("GenBad 2020", { est: 0.9, cil: 0.1, ciu: 0.6 }); // estimate outside CI
    const partial = await mk("GenPartial 2020", { est: 0.2 }); // no se-source at all

    const outcome = await analysis.createOutcome(ctx(s.statistician.id), s.project.id, {
      name: "Adjusted hazard (log)",
      measure: "GENERIC_IV",
    });
    // Estimate alone is not a complete mapping — it needs an SE or both CI bounds.
    let mapped = await analysis.replaceMappings(ctx(s.statistician.id), s.project.id, outcome.id, {
      mappings: [{ role: "EFFECT_ESTIMATE", templateId: template.id, fieldKey: "est" }],
    });
    expect(mapped.mappingComplete).toBe(false);
    mapped = await analysis.replaceMappings(ctx(s.statistician.id), s.project.id, outcome.id, {
      mappings: [
        { role: "EFFECT_ESTIMATE", templateId: template.id, fieldKey: "est" },
        { role: "EFFECT_CI_LOW", templateId: template.id, fieldKey: "cil" },
        { role: "EFFECT_CI_UP", templateId: template.id, fieldKey: "ciu" },
      ],
    });
    expect(mapped.mappingComplete).toBe(true); // CI pair substitutes for the SE

    const results = await analysis.computeOutcomeResults(ctx(s.owner.id), s.project.id, outcome.id);
    expect(results.scale).toBe("linear");
    expect(results.nullValue).toBe(0);
    const byId = new Map(results.rows.map((r) => [r.studyId, r]));
    // se = (ciUp - ciLow) / (2 * 1.959963984540054); display is identity.
    const row1 = byId.get(g1.id)!;
    expect(row1.status).toBe("included");
    expect(row1.effect!.se).toBeCloseTo(0.1173490950926704, 10);
    expect(row1.effect!.display.estimate).toBe(row1.effect!.y);
    expect(byId.get(g2.id)!.effect!.se).toBeCloseTo(0.17857470992362887, 10);
    expect(byId.get(g3.id)!.effect!.se).toBeCloseTo(0.14796190250814964, 10);
    // The engine (not the service) rejects an estimate outside its CI.
    expect(byId.get(bad.id)!.status).toBe("not-pooled");
    expect(byId.get(bad.id)!.reason).toMatch(/outside its confidence interval/);
    // No SE and no CI pair -> incomplete, naming the mapped se-source roles.
    expect(byId.get(partial.id)!.status).toBe("incomplete");
    expect(byId.get(partial.id)!.reason).toMatch(/EFFECT_CI_LOW, EFFECT_CI_UP/);

    expect(results.pooled.fixed!.y).toBeCloseTo(0.22244297241019076, 8);
    expect(results.pooled.random!.y).toBeCloseTo(0.20277452289622538, 8);
    expect(results.heterogeneity!.tau2).toBeCloseTo(0.0293442846499272, 8);
    // k = 3 pooled studies -> PI present (identity display).
    expect(results.predictionInterval!.low).toBeCloseTo(-2.5307259837791807, 6);
    expect(results.predictionInterval!.high).toBeCloseTo(2.936275029571631, 6);
    expect(results.predictionInterval!.display.low).toBe(results.predictionInterval!.low);
    expect(results.egger!.k).toBe(3);
  });

  it("keeps the prediction interval null below k = 3", async () => {
    const s = await setup();
    const a = await s.makeStudy("Two-A 2020");
    const b = await s.makeStudy("Two-B 2020");
    await fillForm(s, a.id, s.extractor1.id, { e1: 30, n1: 60, e2: 15, n2: 60 });
    await fillForm(s, b.id, s.extractor1.id, { e1: 18, n1: 47, e2: 6, n2: 50 });
    const outcome = await binaryOutcome(s);
    const results = await analysis.computeOutcomeResults(ctx(s.owner.id), s.project.id, outcome.id);
    expect(results.rows.filter((r) => r.effect !== null)).toHaveLength(2);
    expect(results.predictionInterval).toBeNull();
    expect(results.egger).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Outcome-field scaffolding
// ---------------------------------------------------------------------------

describe("scaffoldOutcomeFields", () => {
  it("creates fields + outcome + mappings atomically on a draft, with full audit", async () => {
    const s = await setup();
    const draft = await prisma.extractionTemplate.create({
      data: {
        projectId: s.project.id,
        name: "Draft outcomes",
        status: "DRAFT",
        createdById: s.owner.id,
        fields: { create: [{ key: "existing", label: "Existing", type: "NUMBER", order: 0 }] },
      },
    });

    const row = await scaffoldOutcomeFields(ctx(s.statistician.id), s.project.id, {
      templateId: draft.id,
      measure: "PROPORTION",
      name: "Pneumothorax rate",
      keyPrefix: "ptx",
      timepoint: "90 days",
      proportionTransform: "FREEMAN_TUKEY",
    });
    expect(row.measure).toBe("PROPORTION");
    expect(row.proportionTransform).toBe("FREEMAN_TUKEY");
    expect(row.timepoint).toBe("90 days");
    expect(row.mappingComplete).toBe(true);
    expect(row.mappings).toEqual([
      { role: "G1_EVENTS", templateId: draft.id, fieldKey: "ptx_g1_events" },
      { role: "G1_TOTAL", templateId: draft.id, fieldKey: "ptx_g1_total" },
    ]);

    // Fields land on the draft, appended after existing ones, sectioned by outcome name.
    const fields = await prisma.extractionField.findMany({
      where: { templateId: draft.id },
      orderBy: { order: "asc" },
    });
    expect(fields.map((f) => f.key)).toEqual(["existing", "ptx_g1_events", "ptx_g1_total"]);
    expect(fields[1]).toMatchObject({
      type: "NUMBER",
      section: "Pneumothorax rate",
      label: "Events",
      order: 1,
    });
    expect(fields[2]).toMatchObject({ type: "NUMBER", label: "Sample size", order: 2 });

    // Audit: one field event per created field + outcome-created + mappings-replaced.
    const fieldEvents = await prisma.auditEvent.findMany({
      where: {
        projectId: s.project.id,
        action: "extraction.field.created",
        entityId: { in: fields.slice(1).map((f) => f.id) },
      },
    });
    expect(fieldEvents).toHaveLength(2);
    const outcomeEvents = await prisma.auditEvent.findMany({
      where: { projectId: s.project.id, entityId: row.id },
      select: { action: true, newValue: true },
    });
    expect(outcomeEvents.map((e) => e.action).sort()).toEqual([
      "analysis.mappings.replaced",
      "analysis.outcome.created",
    ]);
    const mappingEvent = outcomeEvents.find((e) => e.action === "analysis.mappings.replaced")!;
    expect(
      (mappingEvent.newValue as { mappings: Record<string, unknown> }).mappings.G1_EVENTS,
    ).toEqual({ templateId: draft.id, fieldKey: "ptx_g1_events" });

    // The scaffolded outcome computes like any other (no studies yet -> empty result).
    const results = await analysis.computeOutcomeResults(ctx(s.owner.id), s.project.id, row.id);
    expect(results.scale).toBe("ft");
  });

  it("rejects non-drafts, key collisions (no partial writes), R9, and missing permission", async () => {
    const s = await setup();

    // Published template: fields are frozen.
    await expectAppError(
      scaffoldOutcomeFields(ctx(s.statistician.id), s.project.id, {
        templateId: s.template.id,
        measure: "RR",
        name: "Nope",
        keyPrefix: "nope",
      }),
      "VALIDATION",
    );

    // Key collision -> VALIDATION and nothing written (single transaction).
    const draft = await prisma.extractionTemplate.create({
      data: {
        projectId: s.project.id,
        name: "Collision draft",
        status: "DRAFT",
        createdById: s.owner.id,
        fields: { create: [{ key: "resp_g1_events", label: "Taken", type: "NUMBER", order: 0 }] },
      },
    });
    const outcomesBefore = await prisma.analysisOutcome.count({ where: { projectId: s.project.id } });
    await expectAppError(
      scaffoldOutcomeFields(ctx(s.statistician.id), s.project.id, {
        templateId: draft.id,
        measure: "RR",
        name: "Responders",
        keyPrefix: "resp",
      }),
      "VALIDATION",
    );
    expect(await prisma.analysisOutcome.count({ where: { projectId: s.project.id } })).toBe(
      outcomesBefore,
    );
    expect(await prisma.extractionField.count({ where: { templateId: draft.id } })).toBe(1);

    // R9: a foreign project's draft is invisible from this project.
    const foreign = await createProjectWithTeam();
    const foreignDraft = await prisma.extractionTemplate.create({
      data: {
        projectId: foreign.project.id,
        name: "Foreign draft",
        status: "DRAFT",
        createdById: foreign.owner.id,
      },
    });
    await expectAppError(
      scaffoldOutcomeFields(ctx(s.statistician.id), s.project.id, {
        templateId: foreignDraft.id,
        measure: "RR",
        name: "Foreign",
        keyPrefix: "foreign",
      }),
      "NOT_FOUND",
    );

    // Permissions: needs analysis.manage AND extraction.templates.
    for (const user of [s.adjudicator, s.extractor1, s.reviewer]) {
      await expectAppError(
        scaffoldOutcomeFields(ctx(user.id), s.project.id, {
          templateId: draft.id,
          measure: "RR",
          name: "Denied",
          keyPrefix: "denied",
        }),
        "FORBIDDEN",
      );
    }
  });
});

// ---------------------------------------------------------------------------
// ANALYSIS export
// ---------------------------------------------------------------------------

describe("ANALYSIS export", () => {
  it("gates on export.create, applies requester blinding, and carries pooled numbers", async () => {
    const s = await setup();
    const a = await s.makeStudy("ExpA 2020");
    const b = await s.makeStudy("ExpB 2020");
    const hidden = await s.makeStudy("ExpHidden 2020");
    // a + b: clean dual consensus; hidden: one completed form with the co-extraction
    // still pending -> its SINGLE value is seeAll-only.
    for (const e of [s.extractor1.id, s.extractor2.id]) {
      await fillForm(s, a.id, e, { e1: 60, n1: 128, e2: 10, n2: 62 });
      await fillForm(s, b.id, e, { e1: 18, n1: 47, e2: 6, n2: 50 });
    }
    await fillForm(s, hidden.id, s.extractor1.id, { e1: 30, n1: 60, e2: 15, n2: 60 });
    const outcome = await binaryOutcome(s);

    // Plain REVIEWER lacks export.create.
    await expectAppError(
      createExport(ctx(s.reviewer.id), s.project.id, { kind: "ANALYSIS", format: "JSON" }),
      "FORBIDDEN",
    );

    // Statistician (blinded caller): JSON export with pooled numbers, no SINGLE leak.
    const job = await createExport(ctx(s.statistician.id), s.project.id, {
      kind: "ANALYSIS",
      format: "JSON",
    });
    const file = await downloadExport(ctx(s.statistician.id), s.project.id, job.id);
    expect(file.filename).toBe(`analysis-${s.project.id}.json`);
    const body = JSON.parse(file.body) as {
      outcomes: {
        outcome: { name: string; measure: string };
        rows: { label: string; status: string; values: Record<string, { value: number | null }> }[];
        pooled: { random: { display: { estimate: number } } | null };
        heterogeneity: { tau2: number } | null;
      }[];
    };
    expect(body.outcomes).toHaveLength(1);
    const exported = body.outcomes[0]!;
    expect(exported.outcome).toMatchObject({ name: "Responders", measure: "RR" });
    // Both consensus studies pool; the pooled RR sits between the study estimates.
    expect(exported.rows.filter((r) => r.status === "included")).toHaveLength(2);
    expect(exported.pooled.random!.display.estimate).toBeGreaterThan(2.5);
    expect(exported.pooled.random!.display.estimate).toBeLessThan(3.5);
    // Requester blinding: the lone pre-consensus extraction stays invisible.
    const hiddenRow = exported.rows.find((r) => r.label === "ExpHidden 2020")!;
    expect(hiddenRow.status).toBe("incomplete");
    expect(hiddenRow.values.G1_EVENTS!.value).toBeNull();
    expect(file.body).not.toContain('"SINGLE"');

    // A seeAll requester (owner) exports the SINGLE value.
    const ownerJob = await createExport(ctx(s.owner.id), s.project.id, {
      kind: "ANALYSIS",
      format: "JSON",
    });
    const ownerFile = await downloadExport(ctx(s.owner.id), s.project.id, ownerJob.id);
    const ownerBody = JSON.parse(ownerFile.body) as typeof body;
    const ownerHidden = ownerBody.outcomes[0]!.rows.find((r) => r.label === "ExpHidden 2020")!;
    expect(ownerHidden.status).toBe("included");
    expect(ownerHidden.values.G1_EVENTS!.value).toBe(30);

    // CSV: sectioned rows with a leading recordType column.
    const csvJob = await createExport(ctx(s.statistician.id), s.project.id, {
      kind: "ANALYSIS",
      format: "CSV",
    });
    const csvFile = await downloadExport(ctx(s.statistician.id), s.project.id, csvJob.id);
    expect(csvFile.contentType).toContain("text/csv");
    expect(csvFile.body).toContain("study_effect");
    expect(csvFile.body).toContain("pooled");
    expect(csvFile.body).toContain("outcome_summary");
    expect(csvFile.body).toContain("Responders");
  });
});
