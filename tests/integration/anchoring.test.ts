// Evidence anchoring integration tests (Wave 3A): the server text layer
// (ensureFullTextPages against real hand-built PDFs), v2 anchor production on AI
// suggestion ingest, manual-save anchor validation in upsertValue (R9 + server-side
// re-verification), and the re-anchor backfill's coverage report + audit trail.
import { createHash } from "node:crypto";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/server/db";
import { AppError } from "@/server/errors";
import { normalizeForMatch } from "@/lib/quote-match";
import * as aiExtraction from "@/server/services/ai-extraction";
import * as extraction from "@/server/services/extraction";
import { reanchorExtractionEvidence } from "@/server/services/extraction/reanchor";
import { ensureFullTextPages } from "@/server/services/fulltext-pages";
import { resetAiProviderForTests, setAiProviderForTests } from "@/server/ai/provider";
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
process.env.STORAGE_DIR = mkdtempSync(path.join(os.tmpdir(), "srb-anchoring-it-"));

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

// --- Tiny hand-built PDFs (technique mirrors prisma/seed.ts demoPdf; deliberately
// NOT imported from the seed — tests must not depend on seed internals) -----------

function escapePdfText(line: string): string {
  return line.replace(/[\\()]/g, (c) => `\\${c}`);
}

function buildPdf(tag: string, pages: string[][]): Buffer {
  const objects: string[] = [];
  const pageCount = Math.max(1, pages.length);
  // Object layout: 1 = catalog, 2 = pages, 3 = font, then per page: page obj + content obj.
  const pageObjIds = pages.map((_, i) => 4 + i * 2);
  const contentObjIds = pages.map((_, i) => 5 + i * 2);

  objects[1] = `<</Type/Catalog/Pages 2 0 R>>`;
  objects[2] = `<</Type/Pages/Kids[${pageObjIds.map((id) => `${id} 0 R`).join(" ")}]/Count ${pageCount}>>`;
  objects[3] = `<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>`;
  pages.forEach((lines, i) => {
    const body =
      `BT /F1 11 Tf 72 720 Td 16 TL\n` +
      lines.map((line) => `(${escapePdfText(line)}) Tj T*`).join("\n") +
      `\nET`;
    objects[pageObjIds[i]!] =
      `<</Type/Page/Parent 2 0 R/MediaBox[0 0 612 792]` +
      `/Resources<</Font<</F1 3 0 R>>>>/Contents ${contentObjIds[i]} 0 R>>`;
    objects[contentObjIds[i]!] =
      `<</Length ${Buffer.byteLength(body, "utf8")}>>stream\n${body}\nendstream`;
  });

  let pdf = `%PDF-1.4\n% ${tag}\n`;
  const offsets: number[] = [];
  for (let id = 1; id < objects.length; id += 1) {
    const obj = objects[id];
    if (obj === undefined) continue;
    offsets[id] = Buffer.byteLength(pdf, "utf8");
    pdf += `${id} 0 obj${obj}endobj\n`;
  }
  const xrefOffset = Buffer.byteLength(pdf, "utf8");
  const size = objects.length;
  pdf += `xref\n0 ${size}\n0000000000 65535 f \n`;
  for (let id = 1; id < size; id += 1) {
    pdf += `${String(offsets[id] ?? 0).padStart(10, "0")} 00000 n \n`;
  }
  pdf += `trailer<</Root 1 0 R/Size ${size}>>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  return Buffer.from(pdf, "utf8");
}

const PAGE_1 = [
  "A total of 190 participants were randomized in a 2:1 ratio;",
  "128 received valves and 62 continued standard medical care.",
  "The mean age was 64 years and 47% of participants were female.",
];
const PAGE_2 = [
  "At 12 months, 60 of 128 patients in the valve arm and 10 of 62",
  "in the control arm achieved an FEV1 improvement of at least 15%.",
  "Serious adverse events were more frequent in the treatment group.",
];

async function storePdfFile(projectId: string, uploaderId: string, bytes: Buffer) {
  const key = `${projectId}/${uniq("pdf")}.pdf`;
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

// A study whose primary report links to the given file (or none).
async function createStudyWithPdf(
  projectId: string,
  ownerId: string,
  fileId: string | null,
  label: string,
) {
  const citation = await createTestCitation(projectId);
  if (fileId) {
    await prisma.citationFullTextLink.create({ data: { citationId: citation.id, fileId } });
  }
  return prisma.study.create({
    data: {
      projectId,
      label,
      createdById: ownerId,
      reportLinks: { create: { citationId: citation.id, isPrimaryReport: true } },
    },
  });
}

async function createPublishedTemplate(projectId: string, ownerId: string) {
  return prisma.extractionTemplate.create({
    data: {
      projectId,
      name: "Anchor form",
      status: "PUBLISHED",
      createdById: ownerId,
      fields: {
        create: [
          { key: "sample_size", label: "Sample size", type: "NUMBER", order: 0 },
          { key: "finding", label: "Finding", type: "TEXT", order: 1 },
          { key: "notes_field", label: "Notes", type: "TEXTAREA", order: 2 },
        ],
      },
    },
    include: { fields: { orderBy: { order: "asc" } } },
  });
}

beforeAll(async () => {
  await resetDb();
});

// ---------------------------------------------------------------------------
// ensureFullTextPages
// ---------------------------------------------------------------------------

describe("ensureFullTextPages", () => {
  it("extracts per-page text from a text-bearing PDF, audits, and is idempotent", async () => {
    const { owner, project } = await createProjectWithTeam();
    const file = await storePdfFile(project.id, owner.id, buildPdf("text", [PAGE_1, PAGE_2]));

    const first = await ensureFullTextPages(ctx(owner.id), project.id, file.id);
    expect(first.reused).toBe(false);
    expect(first.file).toMatchObject({ textStatus: "EXTRACTED", pageCount: 2, textVersion: 1 });
    expect(first.pages.map((p) => p.page)).toEqual([1, 2]);
    expect(first.pages[0]!.text).toContain("190 participants were randomized");
    expect(first.pages[1]!.text).toContain("FEV1 improvement");

    const rows = await prisma.fullTextPage.findMany({
      where: { fileId: file.id },
      orderBy: { page: "asc" },
    });
    expect(rows).toHaveLength(2);
    expect(rows[0]!.text).toBe(first.pages[0]!.text);

    // Idempotent: an EXTRACTED layer is reused, no re-extraction, no extra audit.
    const second = await ensureFullTextPages(ctx(owner.id), project.id, file.id);
    expect(second.reused).toBe(true);
    expect(second.file.textVersion).toBe(1);
    expect(second.pages).toEqual(first.pages);

    // force re-extracts and bumps textVersion.
    const forced = await ensureFullTextPages(ctx(owner.id), project.id, file.id, { force: true });
    expect(forced.reused).toBe(false);
    expect(forced.file.textVersion).toBe(2);

    const audits = await prisma.auditEvent.findMany({
      where: { projectId: project.id, action: "fulltext.text.extracted", entityId: file.id },
      orderBy: { createdAt: "asc" },
    });
    expect(audits).toHaveLength(2); // first extraction + forced one; the reuse is silent
    expect(audits[0]!.metadata).toMatchObject({
      status: "EXTRACTED",
      pageCount: 2,
      textVersion: 1,
    });
    expect(audits[1]!.metadata).toMatchObject({ status: "EXTRACTED", textVersion: 2 });
  });

  it("marks image-only PDFs NO_TEXT_LAYER while storing what was found", async () => {
    const { owner, project } = await createProjectWithTeam();
    const file = await storePdfFile(project.id, owner.id, buildPdf("blank", [[]]));

    const result = await ensureFullTextPages(ctx(owner.id), project.id, file.id);
    expect(result.file).toMatchObject({
      textStatus: "NO_TEXT_LAYER",
      pageCount: 1,
      textVersion: 1,
    });
    // The (empty) page row is still stored — page numbering stays complete.
    const rows = await prisma.fullTextPage.findMany({ where: { fileId: file.id } });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.text).toBe("");

    const auditRow = await prisma.auditEvent.findFirst({
      where: { projectId: project.id, action: "fulltext.text.extracted", entityId: file.id },
    });
    expect(auditRow?.metadata).toMatchObject({ status: "NO_TEXT_LAYER", pageCount: 1 });
  });

  it("persists FAILED (never PENDING) when the bytes are not parseable, and rethrows", async () => {
    const { owner, project } = await createProjectWithTeam();
    const file = await storePdfFile(
      project.id,
      owner.id,
      Buffer.from("%PDF-1.4 not actually a pdf"),
    );

    let threw = false;
    try {
      await ensureFullTextPages(ctx(owner.id), project.id, file.id);
    } catch {
      threw = true;
    }
    expect(threw).toBe(true);

    const after = await prisma.fullTextFile.findUniqueOrThrow({ where: { id: file.id } });
    expect(after.textStatus).toBe("FAILED");
    const auditRow = await prisma.auditEvent.findFirst({
      where: { projectId: project.id, action: "fulltext.text.extracted", entityId: file.id },
    });
    expect(auditRow?.metadata).toMatchObject({ status: "FAILED" });
  });

  it("R9: the file must belong to the given project", async () => {
    const { owner, project } = await createProjectWithTeam();
    const other = await createProjectWithTeam();
    const foreignFile = await storePdfFile(
      other.project.id,
      other.owner.id,
      buildPdf("foreign", [PAGE_1]),
    );
    await expectAppError(
      ensureFullTextPages(ctx(owner.id), project.id, foreignFile.id),
      "NOT_FOUND",
    );
  });
});

// ---------------------------------------------------------------------------
// AI ingest → v2 anchors
// ---------------------------------------------------------------------------

describe("AI suggestion ingest anchors", () => {
  let fake: FakeAiProvider;

  beforeEach(() => {
    fake = new FakeAiProvider();
    setAiProviderForTests(fake);
  });

  afterEach(() => {
    resetAiProviderForTests();
  });

  it("writes exact/page-only v2 anchors against the server text layer", async () => {
    const { owner, project } = await createProjectWithTeam();
    const template = await createPublishedTemplate(project.id, owner.id);
    const file = await storePdfFile(project.id, owner.id, buildPdf("ai", [PAGE_1, PAGE_2]));
    const study = await createStudyWithPdf(project.id, owner.id, file.id, "Anchored 2020");

    const exactQuote = "A total of 190 participants were randomized in a 2:1 ratio";
    fake.extractionJson = {
      fields: [
        // Located verbatim on page 1 (hint deliberately wrong: page 2) → exact.
        { key: "sample_size", found: true, value: 190, sourceQuote: exactQuote, pageNumber: 2, confidence: 0.9 },
        // Quote that exists nowhere, valid page hint → page-only.
        { key: "finding", found: true, value: "improved", sourceQuote: "this sentence is not in the document at all", pageNumber: 2, confidence: 0.5 },
        // No quote, no page → legacy shape survives.
        { key: "notes_field", found: false, value: null, sourceQuote: null, pageNumber: null, confidence: null },
      ],
    };

    const { suggestions } = await aiExtraction.runExtractionSuggestion(
      ctx(owner.id),
      project.id,
      study.id,
      { templateId: template.id },
    );
    const byKey = new Map(suggestions.map((s) => [s.field.key, s]));

    // Ingest also (idempotently) built the text layer.
    const fileAfter = await prisma.fullTextFile.findUniqueOrThrow({ where: { id: file.id } });
    expect(fileAfter.textStatus).toBe("EXTRACTED");
    expect(fileAfter.textVersion).toBe(1);

    const exact = byKey.get("sample_size")!.sourceAnchor as Record<string, unknown>;
    expect(exact).toMatchObject({
      v: 2,
      fileId: file.id,
      page: 1,
      matchQuality: "exact",
      matchScore: 1,
      textVersion: 1,
    });
    // Offsets index the normalized stored page text.
    const storedPage1 = await prisma.fullTextPage.findUniqueOrThrow({
      where: { fileId_page: { fileId: file.id, page: 1 } },
    });
    const norm = normalizeForMatch(storedPage1.text);
    expect(norm.slice(exact.charStart as number, exact.charEnd as number)).toBe(exactQuote);

    expect(byKey.get("finding")!.sourceAnchor).toMatchObject({
      v: 2,
      fileId: file.id,
      page: 2,
      matchQuality: "page-only",
      textVersion: 1,
    });
    expect(byKey.get("notes_field")!.sourceAnchor).toEqual({ fileId: file.id, page: null });

    // Applying the suggestion copies the v2 anchor verbatim into the value.
    const { form } = await extraction.startForm(ctx(owner.id), project.id, study.id, {
      templateId: template.id,
    });
    const sampleField = template.fields.find((f) => f.key === "sample_size")!;
    const applied = await extraction.upsertValue(ctx(owner.id), project.id, form.id, sampleField.id, {
      value: null,
      appliedSuggestionId: byKey.get("sample_size")!.id,
    });
    expect(applied?.sourceAnchor).toEqual(byKey.get("sample_size")!.sourceAnchor);
  });

  it("degrades to legacy page anchors when the PDF has no usable text layer", async () => {
    const { owner, project } = await createProjectWithTeam();
    const template = await createPublishedTemplate(project.id, owner.id);
    // Bytes are not parseable → extraction FAILS → legacy anchors, run still succeeds.
    const file = await storePdfFile(project.id, owner.id, Buffer.from("%PDF-1.4 opaque bytes"));
    const study = await createStudyWithPdf(project.id, owner.id, file.id, "Scanned 2021");

    fake.extractionJson = {
      fields: [
        { key: "sample_size", found: true, value: 42, sourceQuote: "n = 42", pageNumber: 3, confidence: 0.7 },
      ],
    };
    const { suggestions } = await aiExtraction.runExtractionSuggestion(
      ctx(owner.id),
      project.id,
      study.id,
      { templateId: template.id },
    );
    const sample = suggestions.find((s) => s.field.key === "sample_size")!;
    expect(sample.sourceAnchor).toEqual({ fileId: file.id, page: 3 });
    const fileAfter = await prisma.fullTextFile.findUniqueOrThrow({ where: { id: file.id } });
    expect(fileAfter.textStatus).toBe("FAILED");
  });
});

// ---------------------------------------------------------------------------
// upsertValue manual anchors
// ---------------------------------------------------------------------------

describe("upsertValue sourceAnchor", () => {
  async function setupForm() {
    const team = await createProjectWithTeam();
    const template = await createPublishedTemplate(team.project.id, team.owner.id);
    const file = await storePdfFile(
      team.project.id,
      team.owner.id,
      buildPdf("manual", [PAGE_1, PAGE_2]),
    );
    const study = await createStudyWithPdf(team.project.id, team.owner.id, file.id, "Manual 2020");
    await ensureFullTextPages(ctx(team.owner.id), team.project.id, file.id);
    const { form } = await extraction.startForm(ctx(team.owner.id), team.project.id, study.id, {
      templateId: template.id,
    });
    const field = template.fields.find((f) => f.key === "finding")!;
    return { ...team, template, file, study, form, field };
  }

  it("re-verifies quoted anchors server-side: server offsets win, selection label survives", async () => {
    const { owner, project, form, field, file } = await setupForm();
    const quote = "128 received valves and 62 continued standard medical care";

    const saved = await extraction.upsertValue(ctx(owner.id), project.id, form.id, field.id, {
      value: "valves",
      sourceQuote: quote,
      pageNumber: 1,
      // Client offsets are deliberately garbage — the server must replace them.
      sourceAnchor: { v: 2, fileId: file.id, page: 1, charStart: 0, charEnd: 5, matchQuality: "selection" },
    });
    const anchor = saved!.sourceAnchor as Record<string, unknown>;
    expect(anchor).toMatchObject({
      v: 2,
      fileId: file.id,
      page: 1,
      matchQuality: "selection", // provenance label kept
      matchScore: 1, // …but the server's exact match is what's stored
      textVersion: 1,
    });
    const storedPage1 = await prisma.fullTextPage.findUniqueOrThrow({
      where: { fileId_page: { fileId: file.id, page: 1 } },
    });
    expect(
      normalizeForMatch(storedPage1.text).slice(anchor.charStart as number, anchor.charEnd as number),
    ).toBe(quote);

    // Non-selection anchors take the server's quality outright.
    const saved2 = await extraction.upsertValue(ctx(owner.id), project.id, form.id, field.id, {
      value: "valves",
      sourceQuote: quote,
      pageNumber: 1,
      sourceAnchor: { v: 2, fileId: file.id, page: 1, matchQuality: "page-only" },
    });
    expect(saved2!.sourceAnchor).toMatchObject({ matchQuality: "exact", matchScore: 1 });

    // Unlocatable quote → offsets dropped, page-only.
    const saved3 = await extraction.upsertValue(ctx(owner.id), project.id, form.id, field.id, {
      value: "valves",
      sourceQuote: "completely absent sentence with zero overlap tokens qqxyzzy",
      pageNumber: 2,
      sourceAnchor: { v: 2, fileId: file.id, page: 2, charStart: 3, charEnd: 9, matchQuality: "exact" },
    });
    expect(saved3!.sourceAnchor).toMatchObject({ v: 2, page: 2, matchQuality: "page-only" });
    expect((saved3!.sourceAnchor as Record<string, unknown>).charStart).toBeUndefined();

    // null clears the anchor.
    const cleared = await extraction.upsertValue(ctx(owner.id), project.id, form.id, field.id, {
      value: "valves",
      sourceAnchor: null,
    });
    expect(cleared!.sourceAnchor).toBeNull();
  });

  it("keeps page + provenance but drops offsets when the file has no text layer yet", async () => {
    const { owner, project, form, field } = await setupForm();
    const pendingFile = await storePdfFile(project.id, owner.id, buildPdf("pending", [PAGE_1]));
    // No ensureFullTextPages call — textStatus stays PENDING, pageCount unknown. Client
    // offsets index nothing we store, so they are dropped; the viewer re-locates by quote.
    const saved = await extraction.upsertValue(ctx(owner.id), project.id, form.id, field.id, {
      value: "valves",
      sourceQuote: "some quote",
      pageNumber: 4,
      sourceAnchor: {
        v: 2 as const,
        fileId: pendingFile.id,
        page: 4,
        charStart: 2,
        charEnd: 10,
        matchQuality: "selection" as const,
      },
    });
    expect(saved!.sourceAnchor).toEqual({
      v: 2,
      fileId: pendingFile.id,
      page: 4,
      matchQuality: "selection",
    });
  });

  it("R9: rejects anchors whose fileId is outside the project; bounds-checks the page", async () => {
    const { owner, project, form, field, file } = await setupForm();
    const other = await createProjectWithTeam();
    const foreignFile = await storePdfFile(
      other.project.id,
      other.owner.id,
      buildPdf("foreign2", [PAGE_1]),
    );

    await expectAppError(
      extraction.upsertValue(ctx(owner.id), project.id, form.id, field.id, {
        value: "x",
        sourceAnchor: { v: 2, fileId: foreignFile.id, page: 1, matchQuality: "page-only" },
      }),
      "NOT_FOUND",
    );

    // Page beyond the known pageCount (2) → validation error.
    await expectAppError(
      extraction.upsertValue(ctx(owner.id), project.id, form.id, field.id, {
        value: "x",
        sourceAnchor: { v: 2, fileId: file.id, page: 7, matchQuality: "page-only" },
      }),
      "VALIDATION",
    );

    // Nothing was persisted by the failed attempts.
    const row = await prisma.extractionValue.findUnique({
      where: { formId_fieldId: { formId: form.id, fieldId: field.id } },
    });
    expect(row).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Re-anchor backfill
// ---------------------------------------------------------------------------

describe("reanchorExtractionEvidence", () => {
  it("backfills anchors, reports coverage, audits per-row and per-run", async () => {
    const team = await createProjectWithTeam();
    const { owner, project } = team;
    const extractor = await createTestUser({ name: "Extractor" });
    await addOrgMember(team.org.id, extractor.id);
    await addProjectMember(project.id, extractor.id, ["EXTRACTOR"]);

    const template = await createPublishedTemplate(project.id, owner.id);
    const sampleField = template.fields.find((f) => f.key === "sample_size")!;
    const findingField = template.fields.find((f) => f.key === "finding")!;

    // Study A: text-bearing PDF → one exact hit + one page-only.
    const fileA = await storePdfFile(project.id, owner.id, buildPdf("bfA", [PAGE_1, PAGE_2]));
    const studyA = await createStudyWithPdf(project.id, owner.id, fileA.id, "Backfill A");
    // Study B: no PDF at all.
    const studyB = await createStudyWithPdf(project.id, owner.id, null, "Backfill B");
    // Study C: image-only PDF (NO_TEXT_LAYER).
    const fileC = await storePdfFile(project.id, owner.id, buildPdf("bfC", [[]]));
    const studyC = await createStudyWithPdf(project.id, owner.id, fileC.id, "Backfill C");

    const makeForm = (studyId: string) =>
      prisma.extractionForm.create({
        data: {
          templateId: template.id,
          studyId,
          extractorId: extractor.id,
          status: "COMPLETED",
          completedAt: new Date(),
        },
      });
    const formA = await makeForm(studyA.id);
    const formB = await makeForm(studyB.id);
    const formC = await makeForm(studyC.id);

    const exactQuote = "At 12 months, 60 of 128 patients in the valve arm";
    const valueExact = await prisma.extractionValue.create({
      data: {
        formId: formA.id,
        fieldId: sampleField.id,
        value: 190,
        sourceQuote: exactQuote,
        pageNumber: 2,
      },
    });
    const valuePageOnly = await prisma.extractionValue.create({
      data: {
        formId: formA.id,
        fieldId: findingField.id,
        value: "improved",
        sourceQuote: "utterly absent qqxyzzy sentence never typed here",
        pageNumber: 1,
      },
    });
    await prisma.extractionValue.create({
      data: { formId: formB.id, fieldId: findingField.id, value: "b", sourceQuote: "quote b" },
    });
    await prisma.extractionValue.create({
      data: { formId: formC.id, fieldId: findingField.id, value: "c", sourceQuote: "quote c", pageNumber: 1 },
    });
    // Quote-less values are out of population entirely.
    await prisma.extractionValue.create({
      data: { formId: formA.id, fieldId: template.fields[2]!.id, value: "no quote" },
    });

    const report = await reanchorExtractionEvidence(ctx(owner.id), project.id, {});
    expect(report).toEqual({
      total: 4,
      exact: 1,
      fuzzy: 0,
      pageOnly: 1,
      noPdf: 1,
      noTextLayer: 1,
    });

    // Anchors written ONLY for study A's values; value/quote/page untouched.
    const exactRow = await prisma.extractionValue.findUniqueOrThrow({
      where: { id: valueExact.id },
    });
    expect(exactRow).toMatchObject({ value: 190, sourceQuote: exactQuote, pageNumber: 2 });
    expect(exactRow.sourceAnchor).toMatchObject({
      v: 2,
      fileId: fileA.id,
      page: 2,
      matchQuality: "exact",
      matchScore: 1,
      textVersion: 1,
    });
    const pageOnlyRow = await prisma.extractionValue.findUniqueOrThrow({
      where: { id: valuePageOnly.id },
    });
    expect(pageOnlyRow.sourceAnchor).toMatchObject({
      v: 2,
      fileId: fileA.id,
      page: 1,
      matchQuality: "page-only",
    });
    const untouched = await prisma.extractionValue.findMany({
      where: { formId: { in: [formB.id, formC.id] } },
    });
    expect(untouched.every((v) => v.sourceAnchor === null)).toBe(true);

    // Per-row audits for the two written anchors + exactly one run summary.
    const rowAudits = await prisma.auditEvent.findMany({
      where: { projectId: project.id, action: "extraction.value.reanchored" },
    });
    expect(rowAudits).toHaveLength(2);
    expect(rowAudits.map((a) => (a.metadata as { matchQuality: string }).matchQuality).sort()).toEqual(
      ["exact", "page-only"],
    );
    const runAudits = await prisma.auditEvent.findMany({
      where: { projectId: project.id, action: "extraction.reanchor.run" },
    });
    expect(runAudits).toHaveLength(1);
    expect(runAudits[0]!.metadata).toMatchObject(report);

    // Idempotent re-run: anchors refresh in place, coverage identical.
    const again = await reanchorExtractionEvidence(ctx(owner.id), project.id, {
      templateId: template.id,
    });
    expect(again).toEqual(report);

    // Guards: permission (extractors cannot run it) and R9 template scoping.
    await expectAppError(
      reanchorExtractionEvidence(ctx(extractor.id), project.id, {}),
      "FORBIDDEN",
    );
    const other = await createProjectWithTeam();
    const foreignTemplate = await createPublishedTemplate(other.project.id, other.owner.id);
    await expectAppError(
      reanchorExtractionEvidence(ctx(owner.id), project.id, { templateId: foreignTemplate.id }),
      "NOT_FOUND",
    );
  });
});
