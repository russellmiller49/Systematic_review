// AI extraction integration tests — synchronous suggestion runs against the FakeAiProvider,
// mixed valid/invalid/notFound handling, latest-wins re-runs, the appliedSuggestionId apply
// path through upsertValue (server-authoritative copy + sourceAnchor + audit provenance),
// PDF resolution, and permission/guard rails.
import { createHash } from "node:crypto";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/server/db";
import { AppError } from "@/server/errors";
import * as aiExtraction from "@/server/services/ai-extraction";
import * as extraction from "@/server/services/extraction";
import { resetAiProviderForTests, setAiProviderForTests } from "@/server/ai/provider";
import { EXTRACTION_PROMPT_VERSION } from "@/server/ai/prompts/extraction";
import { getStorage } from "@/server/storage";
import { FakeAiProvider } from "../fake-ai-provider";
import { resetDb } from "../db-utils";
import {
  addOrgMember,
  addProjectMember,
  createProjectWithTeam,
  createTestCitation,
  createTestUser,
  uniq,
} from "../factories";

// Point the lazy storage singleton at a temp dir BEFORE the first storage call.
process.env.STORAGE_DIR = mkdtempSync(path.join(os.tmpdir(), "srb-ai-extraction-it-"));

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

async function createPdfFile(projectId: string, uploaderId: string, body = "%PDF-1.4 test body") {
  const key = `${projectId}/${uniq("pdf")}.pdf`;
  const bytes = Buffer.from(body);
  await getStorage().put(key, bytes);
  return prisma.fullTextFile.create({
    data: {
      projectId,
      storageKey: key,
      filename: `${uniq("paper")}.pdf`,
      contentType: "application/pdf",
      sizeBytes: bytes.byteLength,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      uploadedById: uploaderId,
    },
  });
}

async function setup() {
  const team = await createProjectWithTeam();
  const extractor = await createTestUser({ name: "Extractor" });
  const observer = await createTestUser({ name: "Observer" });
  await addOrgMember(team.org.id, extractor.id);
  await addOrgMember(team.org.id, observer.id);
  await addProjectMember(team.project.id, extractor.id, ["EXTRACTOR"]);
  await addProjectMember(team.project.id, observer.id, ["OBSERVER"]);

  const template = await prisma.extractionTemplate.create({
    data: {
      projectId: team.project.id,
      name: "Main form",
      status: "PUBLISHED",
      createdById: team.owner.id,
      fields: {
        create: [
          { key: "sample_size", label: "Sample size", type: "NUMBER", required: true, order: 0 },
          {
            key: "design",
            label: "Design",
            type: "SINGLE_SELECT",
            options: [
              { value: "rct", label: "RCT" },
              { value: "cohort", label: "Cohort" },
            ],
            order: 1,
          },
          { key: "start_date", label: "Start date", type: "DATE", order: 2 },
          {
            key: "outcomes",
            label: "Outcomes",
            type: "MULTI_SELECT",
            options: [
              { value: "mortality", label: "Mortality" },
              { value: "qol", label: "Quality of life" },
            ],
            order: 3,
          },
          { key: "blinded_trial", label: "Blinded", type: "BOOLEAN", order: 4 },
          { key: "notes_field", label: "Notes", type: "TEXTAREA", order: 5 },
        ],
      },
    },
    include: { fields: { orderBy: { order: "asc" } } },
  });

  const citation = await createTestCitation(team.project.id);
  const study = await prisma.study.create({
    data: {
      projectId: team.project.id,
      label: "Smith 2020",
      createdById: team.owner.id,
      reportLinks: { create: { citationId: citation.id, isPrimaryReport: true } },
    },
  });
  const file = await createPdfFile(team.project.id, team.owner.id);
  await prisma.citationFullTextLink.create({
    data: { citationId: citation.id, fileId: file.id },
  });
  const fieldByKey = new Map(template.fields.map((f) => [f.key, f]));
  return { ...team, extractor, observer, template, citation, study, file, fieldByKey };
}

// One entry per behavior class: valid NUMBER, valid SINGLE_SELECT, invalid DATE, invalid
// MULTI_SELECT option, found:false BOOLEAN, missing key (notes_field), unknown key.
const MIXED_RESULT = {
  fields: [
    { key: "sample_size", found: true, value: 120, sourceQuote: "n = 120", pageNumber: 3, confidence: 0.95 },
    { key: "design", found: true, value: "rct", sourceQuote: "randomized trial", pageNumber: 1, confidence: 0.9 },
    { key: "start_date", found: true, value: "2020-13-45", sourceQuote: "enrollment", pageNumber: 2, confidence: 0.4 },
    { key: "outcomes", found: true, value: ["mortality", "bogus"], sourceQuote: null, pageNumber: null, confidence: null },
    { key: "blinded_trial", found: false, value: null, sourceQuote: null, pageNumber: null, confidence: null },
    { key: "unknown_key", found: true, value: "x", sourceQuote: null, pageNumber: null, confidence: null },
  ],
};

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

describe("ai extraction suggestion runs", () => {
  it("stores valid, invalid, and not-found suggestions with correct counts", async () => {
    const { extractor, project, study, template, file, fieldByKey } = await setup();
    fake.extractionJson = MIXED_RESULT;

    const { run, suggestions } = await aiExtraction.runExtractionSuggestion(
      ctx(extractor.id),
      project.id,
      study.id,
      { templateId: template.id },
    );
    expect(run).toMatchObject({
      status: "COMPLETED",
      totalFields: 6,
      suggestedCount: 2,
      invalidCount: 2,
      notFoundCount: 2,
      provider: "anthropic",
      promptVersion: EXTRACTION_PROMPT_VERSION,
    });
    expect(run.usage).toEqual({ inputTokens: 1000, outputTokens: 100 });
    expect(suggestions).toHaveLength(6);

    // The provider saw the stored PDF and a prompt naming every field key.
    expect(fake.extractCalls[0]!.filename).toBe(file.filename);
    expect(fake.extractCalls[0]!.pdfBytes).toBeGreaterThan(0);
    expect(fake.extractCalls[0]!.prompt.user).toContain('key "sample_size"');

    const byFieldId = new Map(suggestions.map((s) => [s.fieldId, s]));
    const sample = byFieldId.get(fieldByKey.get("sample_size")!.id)!;
    expect(sample).toMatchObject({
      value: 120,
      sourceQuote: "n = 120",
      pageNumber: 3,
      confidence: 0.95,
      notFound: false,
      invalidReason: null,
    });
    expect(sample.sourceAnchor).toEqual({ fileId: file.id, page: 3 });

    const badDate = byFieldId.get(fieldByKey.get("start_date")!.id)!;
    expect(badDate.invalidReason).toContain("yyyy-mm-dd");
    expect(badDate.value).toBe("2020-13-45"); // raw value kept for transparency

    const badOptions = byFieldId.get(fieldByKey.get("outcomes")!.id)!;
    expect(badOptions.invalidReason).not.toBeNull();

    const notFound = byFieldId.get(fieldByKey.get("blinded_trial")!.id)!;
    expect(notFound).toMatchObject({ notFound: true, value: null, invalidReason: null });
    const missing = byFieldId.get(fieldByKey.get("notes_field")!.id)!;
    expect(missing.notFound).toBe(true);

    // Run-level audit only.
    const actions = await prisma.auditEvent.findMany({
      where: { projectId: project.id, action: { startsWith: "ai.extraction" } },
      select: { action: true },
    });
    expect(actions.map((a) => a.action).sort()).toEqual([
      "ai.extraction.completed",
      "ai.extraction.started",
    ]);

    // listSuggestions returns the same rows ordered by field order, plus run + pdf info.
    const listed = await aiExtraction.listSuggestions(ctx(extractor.id), project.id, study.id, {
      templateId: template.id,
    });
    expect(listed.suggestions.map((s) => s.field.key)).toEqual([
      "sample_size",
      "design",
      "start_date",
      "outcomes",
      "blinded_trial",
      "notes_field",
    ]);
    expect(listed.latestRun?.id).toBe(run.id);
    expect(listed.pdf).toEqual({
      fileId: file.id,
      filename: file.filename,
      sizeBytes: file.sizeBytes,
    });
  });

  it("re-runs replace the previous suggestions (latest-wins)", async () => {
    const { extractor, project, study, template, fieldByKey } = await setup();
    fake.extractionJson = MIXED_RESULT;
    await aiExtraction.runExtractionSuggestion(ctx(extractor.id), project.id, study.id, {
      templateId: template.id,
    });

    fake.extractionJson = {
      fields: [
        { key: "sample_size", found: true, value: 200, sourceQuote: "n = 200", pageNumber: 5, confidence: 0.8 },
      ],
    };
    const { run: secondRun } = await aiExtraction.runExtractionSuggestion(
      ctx(extractor.id),
      project.id,
      study.id,
      { templateId: template.id },
    );

    const rows = await prisma.extractionSuggestion.findMany({
      where: { templateId: template.id, studyId: study.id },
    });
    expect(rows).toHaveLength(6); // full replace, one row per field
    expect(rows.every((r) => r.runId === secondRun.id)).toBe(true);
    const sample = rows.find((r) => r.fieldId === fieldByKey.get("sample_size")!.id)!;
    expect(sample.value).toBe(200);
    expect(rows.filter((r) => r.notFound)).toHaveLength(5);
  });

  it("applies a suggestion into the extractor's own form server-authoritatively", async () => {
    const { extractor, project, study, template, citation, file, fieldByKey } = await setup();
    fake.extractionJson = MIXED_RESULT;
    const { suggestions } = await aiExtraction.runExtractionSuggestion(
      ctx(extractor.id),
      project.id,
      study.id,
      { templateId: template.id },
    );
    const byKey = new Map(suggestions.map((s) => [s.field.key, s]));

    await prisma.extractionAssignment.create({
      data: { templateId: template.id, studyId: study.id, extractorId: extractor.id },
    });
    const { form } = await extraction.startForm(ctx(extractor.id), project.id, study.id, {
      templateId: template.id,
      citationId: citation.id,
    });

    const sampleField = fieldByKey.get("sample_size")!;
    const applied = await extraction.upsertValue(
      ctx(extractor.id),
      project.id,
      form.id,
      sampleField.id,
      // Client-sent value is ignored on apply — the suggestion row is authoritative.
      { value: 999, appliedSuggestionId: byKey.get("sample_size")!.id },
    );
    expect(applied).toMatchObject({
      value: 120,
      sourceQuote: "n = 120",
      pageNumber: 3,
    });
    expect(applied?.sourceAnchor).toEqual({ fileId: file.id, page: 3 });

    // Audit provenance: the value event carries the suggestion id + provider/model.
    const valueEvent = await prisma.auditEvent.findFirst({
      where: { projectId: project.id, action: "extraction.value.created" },
      orderBy: { createdAt: "desc" },
    });
    const metadata = valueEvent?.metadata as Record<string, unknown>;
    expect(metadata.appliedFromSuggestionId).toBe(byKey.get("sample_size")!.id);
    expect(metadata.aiProvider).toBe("anthropic");
    expect(typeof metadata.aiModel).toBe("string");

    // Non-applyable suggestions are rejected: invalid, notFound, or wrong field.
    await expectAppError(
      extraction.upsertValue(ctx(extractor.id), project.id, form.id, fieldByKey.get("start_date")!.id, {
        value: null,
        appliedSuggestionId: byKey.get("start_date")!.id, // invalidReason set
      }),
      "NOT_FOUND",
    );
    await expectAppError(
      extraction.upsertValue(
        ctx(extractor.id),
        project.id,
        form.id,
        fieldByKey.get("blinded_trial")!.id,
        { value: null, appliedSuggestionId: byKey.get("blinded_trial")!.id }, // notFound
      ),
      "NOT_FOUND",
    );
    await expectAppError(
      extraction.upsertValue(ctx(extractor.id), project.id, form.id, sampleField.id, {
        value: null,
        appliedSuggestionId: byKey.get("design")!.id, // belongs to another field
      }),
      "NOT_FOUND",
    );

    // Applying still runs validateFieldValue: a (hand-forged) applyable suggestion whose
    // value no longer matches the field type is rejected, not written.
    const forged = await prisma.extractionSuggestion.update({
      where: { id: byKey.get("design")!.id },
      data: { value: "bogus-option" },
    });
    await expectAppError(
      extraction.upsertValue(ctx(extractor.id), project.id, form.id, fieldByKey.get("design")!.id, {
        value: null,
        appliedSuggestionId: forged.id,
      }),
      "VALIDATION",
    );

    // A RESOLVED conflict still locks the field against applies.
    const conflictRow = await prisma.extractionConflict.create({
      data: {
        templateId: template.id,
        studyId: study.id,
        fieldId: fieldByKey.get("design")!.id,
        status: "RESOLVED",
        resolvedAt: new Date(),
      },
    });
    await prisma.extractionSuggestion.update({
      where: { id: forged.id },
      data: { value: "rct" },
    });
    await expectAppError(
      extraction.upsertValue(ctx(extractor.id), project.id, form.id, fieldByKey.get("design")!.id, {
        value: null,
        appliedSuggestionId: forged.id,
      }),
      "INVALID_STATE",
    );
    await prisma.extractionConflict.delete({ where: { id: conflictRow.id } });
  });

  it("prefers the primary report's PDF and fails cleanly on missing/oversized PDFs", async () => {
    const { owner, extractor, project, template } = await setup();

    // Two reports: non-primary with fileA, primary with fileB → fileB wins.
    const citationA = await createTestCitation(project.id);
    const citationB = await createTestCitation(project.id);
    const fileA = await createPdfFile(project.id, owner.id, "%PDF-1.4 A");
    const fileB = await createPdfFile(project.id, owner.id, "%PDF-1.4 B");
    await prisma.citationFullTextLink.createMany({
      data: [
        { citationId: citationA.id, fileId: fileA.id },
        { citationId: citationB.id, fileId: fileB.id },
      ],
    });
    const study = await prisma.study.create({
      data: {
        projectId: project.id,
        label: "Two Reports 2021",
        createdById: owner.id,
        reportLinks: {
          create: [
            { citationId: citationA.id, isPrimaryReport: false },
            { citationId: citationB.id, isPrimaryReport: true },
          ],
        },
      },
    });
    const listed = await aiExtraction.listSuggestions(ctx(extractor.id), project.id, study.id, {
      templateId: template.id,
    });
    expect(listed.pdf?.fileId).toBe(fileB.id);

    // No PDF at all.
    const bare = await prisma.study.create({
      data: { projectId: project.id, label: "No PDF 2021", createdById: owner.id },
    });
    await expectAppError(
      aiExtraction.runExtractionSuggestion(ctx(extractor.id), project.id, bare.id, {
        templateId: template.id,
      }),
      "INVALID_STATE",
    );

    // Over the provider's PDF cap.
    fake.maxPdfBytes = 4;
    await expectAppError(
      aiExtraction.runExtractionSuggestion(ctx(extractor.id), project.id, study.id, {
        templateId: template.id,
      }),
      "INVALID_STATE",
    );
    expect(fake.extractCalls).toHaveLength(0); // rejected before any provider call
  });

  it("guards: template state, permissions, disabled provider, malformed model output", async () => {
    const { owner, extractor, observer, project, study, template } = await setup();

    const draft = await prisma.extractionTemplate.create({
      data: { projectId: project.id, name: "Draft", status: "DRAFT", createdById: owner.id },
    });
    await expectAppError(
      aiExtraction.runExtractionSuggestion(ctx(extractor.id), project.id, study.id, {
        templateId: draft.id,
      }),
      "INVALID_STATE",
    );

    const emptyPublished = await prisma.extractionTemplate.create({
      data: { projectId: project.id, name: "Empty", status: "PUBLISHED", createdById: owner.id },
    });
    await expectAppError(
      aiExtraction.runExtractionSuggestion(ctx(extractor.id), project.id, study.id, {
        templateId: emptyPublished.id,
      }),
      "INVALID_STATE",
    );

    await expectAppError(
      aiExtraction.runExtractionSuggestion(ctx(observer.id), project.id, study.id, {
        templateId: template.id,
      }),
      "FORBIDDEN",
    );
    await expectAppError(
      aiExtraction.listSuggestions(ctx(observer.id), project.id, study.id, {
        templateId: template.id,
      }),
      "FORBIDDEN",
    );

    setAiProviderForTests(null);
    await expectAppError(
      aiExtraction.runExtractionSuggestion(ctx(extractor.id), project.id, study.id, {
        templateId: template.id,
      }),
      "INVALID_STATE",
    );
    setAiProviderForTests(fake);

    // Malformed model output → run FAILED + audited, INVALID_STATE surfaced.
    fake.extractionJson = { nope: true };
    await expectAppError(
      aiExtraction.runExtractionSuggestion(ctx(extractor.id), project.id, study.id, {
        templateId: template.id,
      }),
      "INVALID_STATE",
    );
    const failed = await prisma.aiExtractionRun.findFirst({
      where: { studyId: study.id, status: "FAILED" },
    });
    expect(failed).not.toBeNull();
    expect(
      await prisma.auditEvent.count({
        where: { projectId: project.id, action: "ai.extraction.failed" },
      }),
    ).toBe(1);
    expect(
      await prisma.extractionSuggestion.count({
        where: { templateId: template.id, studyId: study.id },
      }),
    ).toBe(0);
  });
});
