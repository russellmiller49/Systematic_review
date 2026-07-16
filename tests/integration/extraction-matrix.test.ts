// Extraction matrix integration tests — cell resolution end-to-end through the real
// extraction services (dual completion → agreement/conflict → adjudication) and the
// listForms-mirrored blinding rule (extractors see only their own entries; adjudicators
// and admins see everything including adjudications).
import { beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/server/db";
import { AppError } from "@/server/errors";
import * as extraction from "@/server/services/extraction";
import { getExtractionMatrix } from "@/server/services/extraction/matrix";
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

async function setup() {
  const team = await createProjectWithTeam();
  const extractor1 = await createTestUser({ name: "Extractor One" });
  const extractor2 = await createTestUser({ name: "Extractor Two" });
  const adjudicator = await createTestUser({ name: "Adjudicator" });
  for (const user of [extractor1, extractor2, adjudicator]) {
    await addOrgMember(team.org.id, user.id);
  }
  await addProjectMember(team.project.id, extractor1.id, ["EXTRACTOR"]);
  await addProjectMember(team.project.id, extractor2.id, ["EXTRACTOR"]);
  await addProjectMember(team.project.id, adjudicator.id, ["ADJUDICATOR"]);

  const template = await prisma.extractionTemplate.create({
    data: {
      projectId: team.project.id,
      name: "Matrix form",
      status: "PUBLISHED",
      createdById: team.owner.id,
      fields: {
        create: [
          { key: "sample_size", label: "Sample size", type: "NUMBER", order: 0 },
          { key: "country", label: "Country", type: "TEXT", order: 1 },
        ],
      },
    },
    include: { fields: { orderBy: { order: "asc" } } },
  });
  const [sampleField, countryField] = template.fields;

  const citation = await createTestCitation(team.project.id);
  const study = await prisma.study.create({
    data: {
      projectId: team.project.id,
      label: "Alpha 2020",
      createdById: team.owner.id,
      reportLinks: { create: { citationId: citation.id, isPrimaryReport: true } },
    },
  });
  await prisma.extractionAssignment.createMany({
    data: [
      { templateId: template.id, studyId: study.id, extractorId: extractor1.id },
      { templateId: template.id, studyId: study.id, extractorId: extractor2.id },
    ],
  });
  return {
    ...team,
    extractor1,
    extractor2,
    adjudicator,
    template,
    study,
    citation,
    sampleField: sampleField!,
    countryField: countryField!,
  };
}

type Setup = Awaited<ReturnType<typeof setup>>;

async function fillAndComplete(
  s: Setup,
  extractorId: string,
  values: { sample: number; country: string },
) {
  const { form } = await extraction.startForm(ctx(extractorId), s.project.id, s.study.id, {
    templateId: s.template.id,
    citationId: s.citation.id,
  });
  await extraction.upsertValue(ctx(extractorId), s.project.id, form.id, s.sampleField.id, {
    value: values.sample,
    sourceQuote: `n = ${values.sample}`,
    pageNumber: 2,
  });
  await extraction.upsertValue(ctx(extractorId), s.project.id, form.id, s.countryField.id, {
    value: values.country,
  });
  await extraction.completeForm(ctx(extractorId), s.project.id, form.id);
  return form;
}

beforeAll(async () => {
  await resetDb();
});

describe("getExtractionMatrix", () => {
  it("resolves agreement, disputes, and adjudication with correct precedence", async () => {
    const s = await setup();
    // Both extractors agree on sample_size (120) but disagree on country.
    await fillAndComplete(s, s.extractor1.id, { sample: 120, country: "Sweden" });
    await fillAndComplete(s, s.extractor2.id, { sample: 120, country: "Norway" });

    const matrix = await getExtractionMatrix(ctx(s.adjudicator.id), s.project.id, {
      templateId: s.template.id,
    });
    expect(matrix.seeAll).toBe(true);
    expect(matrix.fields.map((f) => f.key)).toEqual(["sample_size", "country"]);
    expect(matrix.studies).toHaveLength(1);

    const row = matrix.studies[0]!;
    expect(row.label).toBe("Alpha 2020");
    const sampleCell = row.cells[s.sampleField.id]!;
    expect(sampleCell.resolved).toEqual({ value: 120, source: "AGREED" });
    expect(sampleCell.entries).toHaveLength(2);
    expect(sampleCell.entries[0]!.sourceQuote).toBe("n = 120");

    const countryCell = row.cells[s.countryField.id]!;
    expect(countryCell).toMatchObject({ resolved: null, disputed: true });
    expect(countryCell.entries.map((e) => e.value).sort()).toEqual(["Norway", "Sweden"]);

    // Adjudicate the country conflict → ADJUDICATED wins.
    const conflicts = await extraction.listConflicts(ctx(s.adjudicator.id), s.project.id, {});
    const conflict = conflicts.find((c) => c.fieldId === s.countryField.id)!;
    await extraction.adjudicateConflict(ctx(s.adjudicator.id), s.project.id, conflict.id, {
      finalValue: "Sweden",
      reason: "Author affiliation confirms Sweden",
    });

    const after = await getExtractionMatrix(ctx(s.adjudicator.id), s.project.id, {
      templateId: s.template.id,
    });
    const adjudicated = after.studies[0]!.cells[s.countryField.id]!;
    expect(adjudicated.resolved).toEqual({ value: "Sweden", source: "ADJUDICATED" });
    expect(adjudicated.disputed).toBe(false);
    expect(adjudicated.adjudication).toMatchObject({
      finalValue: "Sweden",
      reason: "Author affiliation confirms Sweden",
    });
  });

  it("blinds plain extractors to co-extractor entries and adjudication data", async () => {
    const s = await setup();
    await fillAndComplete(s, s.extractor1.id, { sample: 80, country: "Chile" });
    await fillAndComplete(s, s.extractor2.id, { sample: 90, country: "Chile" });

    const mine = await getExtractionMatrix(ctx(s.extractor1.id), s.project.id, {
      templateId: s.template.id,
    });
    expect(mine.seeAll).toBe(false);
    const row = mine.studies.find((r) => r.id === s.study.id)!;
    const sampleCell = row.cells[s.sampleField.id]!;
    // Only their own single entry — resolved as SINGLE, no dispute leak, no adjudication.
    expect(sampleCell.entries).toHaveLength(1);
    expect(sampleCell.entries[0]!.extractor.id).toBe(s.extractor1.id);
    expect(sampleCell.resolved).toEqual({ value: 80, source: "SINGLE" });
    expect(sampleCell.disputed).toBe(false);
    expect(sampleCell.adjudication).toBeUndefined();

    // Admins see everything (project.edit path of the rule).
    const admin = await getExtractionMatrix(ctx(s.owner.id), s.project.id, {
      templateId: s.template.id,
    });
    expect(admin.seeAll).toBe(true);
    expect(admin.studies.find((r) => r.id === s.study.id)!.cells[s.sampleField.id]!.entries).toHaveLength(2);
  });

  it("includes study PDF descriptors, in-progress entries, and guards", async () => {
    const s = await setup();
    // In-progress (not completed) → entry visible, nothing resolved.
    const { form } = await extraction.startForm(ctx(s.extractor1.id), s.project.id, s.study.id, {
      templateId: s.template.id,
      citationId: s.citation.id,
    });
    await extraction.upsertValue(ctx(s.extractor1.id), s.project.id, form.id, s.sampleField.id, {
      value: 55,
    });

    const matrix = await getExtractionMatrix(ctx(s.owner.id), s.project.id, {
      templateId: s.template.id,
    });
    const row = matrix.studies.find((r) => r.id === s.study.id)!;
    expect(row.pdf).toBeNull(); // no PDF linked in this setup
    const cell = row.cells[s.sampleField.id]!;
    expect(cell.resolved).toBeNull();
    expect(cell.disputed).toBe(false);
    expect(cell.entries[0]!).toMatchObject({ value: 55, formStatus: "IN_PROGRESS" });

    // Cross-project template → 404; template from another project is invisible.
    const foreign = await createProjectWithTeam();
    await expectAppError(
      getExtractionMatrix(ctx(s.owner.id), s.project.id, {
        templateId: (
          await prisma.extractionTemplate.create({
            data: {
              projectId: foreign.project.id,
              name: "Foreign",
              status: "PUBLISHED",
              createdById: foreign.owner.id,
            },
          })
        ).id,
      }),
      "NOT_FOUND",
    );

    // Non-members can't read the matrix at all.
    const stranger = await createTestUser({ name: "Stranger" });
    await expectAppError(
      getExtractionMatrix(ctx(stranger.id), s.project.id, { templateId: s.template.id }),
      "FORBIDDEN",
    );
  });
});
