// Extraction domain integration tests — services against real Postgres.
// Covers: template builder + publish freeze + versioning (R16), typed value validation,
// required-at-completion, value audit previousValue, dual-extraction conflict lifecycle
// (R15: open → auto-void on agreement → adjudicate → post-adjudication lock, R5 mirror),
// blind form listing, and assignment gating with implicit admin self-assign.
import { beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/server/db";
import { AppError } from "@/server/errors";
import * as extraction from "@/server/services/extraction";
import { resetDb } from "../db-utils";
import {
  addOrgMember,
  addProjectMember,
  createTestOrg,
  createTestProject,
  createTestUser,
  uniq,
} from "../factories";

const ctx = (userId: string) => ({ userId });

async function expectAppError(promise: Promise<unknown>, code: string): Promise<AppError> {
  try {
    await promise;
    expect.fail(`expected AppError(${code}) but call succeeded`);
  } catch (err) {
    if (!(err instanceof AppError)) throw err;
    expect(err.code).toBe(code);
    return err;
  }
}

// Local precondition helpers (this file only — factories.ts is shared and frozen).

async function setupTeam() {
  const owner = await createTestUser({ name: "Owner" });
  const extractorA = await createTestUser({ name: "Extractor A" });
  const extractorB = await createTestUser({ name: "Extractor B" });
  const adjudicator = await createTestUser({ name: "Adjudicator" });
  const observer = await createTestUser({ name: "Observer" });
  const org = await createTestOrg(owner.id);
  for (const u of [extractorA, extractorB, adjudicator, observer]) {
    await addOrgMember(org.id, u.id);
  }
  const project = await createTestProject(org.id, owner.id);
  await addProjectMember(project.id, extractorA.id, ["EXTRACTOR"]);
  await addProjectMember(project.id, extractorB.id, ["EXTRACTOR"]);
  await addProjectMember(project.id, adjudicator.id, ["ADJUDICATOR"]);
  await addProjectMember(project.id, observer.id, ["OBSERVER"]);
  return { owner, extractorA, extractorB, adjudicator, observer, org, project };
}

async function createStudy(projectId: string, createdById: string) {
  return prisma.study.create({
    data: { projectId, label: uniq("Study"), createdById },
  });
}

type FieldInput = Parameters<typeof extraction.createField>[3];

async function makePublishedTemplate(ownerId: string, projectId: string, fields: FieldInput[]) {
  const template = await extraction.createTemplate(ctx(ownerId), projectId, {
    name: uniq("Template"),
  });
  for (const f of fields) {
    await extraction.createField(ctx(ownerId), projectId, template.id, f);
  }
  return extraction.publishTemplate(ctx(ownerId), projectId, template.id);
}

describe("extraction templates & fields", () => {
  beforeAll(async () => {
    await resetDb();
  });

  it("builds, publishes, and freezes a template (R16 publish freeze)", async () => {
    const { owner, project } = await setupTeam();

    // publishing an empty template is rejected
    const empty = await extraction.createTemplate(ctx(owner.id), project.id, {
      name: uniq("Empty"),
    });
    await expectAppError(
      extraction.publishTemplate(ctx(owner.id), project.id, empty.id),
      "INVALID_STATE",
    );

    const template = await extraction.createTemplate(ctx(owner.id), project.id, {
      name: uniq("Baseline"),
      description: "Baseline characteristics",
    });
    expect(template.status).toBe("DRAFT");
    expect(template.version).toBe(1);

    const field = await extraction.createField(ctx(owner.id), project.id, template.id, {
      key: "sample_size",
      label: "Sample size",
      type: "NUMBER",
      required: true,
    });
    await prisma.auditEvent.findFirstOrThrow({
      where: { entityType: "ExtractionField", entityId: field.id, action: "extraction.field.created" },
    });

    // duplicate key rejected
    await expectAppError(
      extraction.createField(ctx(owner.id), project.id, template.id, {
        key: "sample_size",
        label: "Duplicate",
        type: "TEXT",
      }),
      "CONFLICT",
    );
    // select without options rejected
    await expectAppError(
      extraction.createField(ctx(owner.id), project.id, template.id, {
        key: "design",
        label: "Design",
        type: "SINGLE_SELECT",
      }),
      "VALIDATION",
    );
    // key format enforced at the schema boundary
    expect(extraction.createFieldSchema.safeParse({ key: "BadKey", label: "x", type: "TEXT" }).success).toBe(false);
    expect(extraction.createFieldSchema.safeParse({ key: "9lives", label: "x", type: "TEXT" }).success).toBe(false);

    const published = await extraction.publishTemplate(ctx(owner.id), project.id, template.id);
    expect(published.status).toBe("PUBLISHED");
    await prisma.auditEvent.findFirstOrThrow({
      where: {
        entityType: "ExtractionTemplate",
        entityId: template.id,
        action: "extraction.template.published",
      },
    });

    // structural edits frozen after publish
    await expectAppError(
      extraction.createField(ctx(owner.id), project.id, template.id, {
        key: "another",
        label: "Another",
        type: "TEXT",
      }),
      "INVALID_STATE",
    );
    await expectAppError(
      extraction.updateField(ctx(owner.id), project.id, template.id, field.id, { label: "New" }),
      "INVALID_STATE",
    );
    await expectAppError(
      extraction.deleteField(ctx(owner.id), project.id, template.id, field.id),
      "INVALID_STATE",
    );
    // ...but meta edits stay allowed (R16)
    const renamed = await extraction.updateTemplate(ctx(owner.id), project.id, template.id, {
      name: "Baseline v1 (final)",
    });
    expect(renamed.name).toBe("Baseline v1 (final)");
    // publish is not idempotent
    await expectAppError(
      extraction.publishTemplate(ctx(owner.id), project.id, template.id),
      "INVALID_STATE",
    );
  });

  it("extractors cannot manage templates; cross-project template loads are 404 (R9)", async () => {
    const { owner, extractorA, project } = await setupTeam();
    await expectAppError(
      extraction.createTemplate(ctx(extractorA.id), project.id, { name: uniq("Nope") }),
      "FORBIDDEN",
    );
    const other = await setupTeam();
    const template = await extraction.createTemplate(ctx(owner.id), project.id, {
      name: uniq("Mine"),
    });
    await expectAppError(
      extraction.getTemplate(ctx(other.owner.id), other.project.id, template.id),
      "NOT_FOUND",
    );
  });

  it("new-version clones template+fields; publishing the clone archives the source (R16)", async () => {
    const { owner, project } = await setupTeam();
    const v1 = await makePublishedTemplate(owner.id, project.id, [
      { key: "outcome", label: "Outcome", type: "TEXT", required: true },
      {
        key: "arm",
        label: "Arm",
        type: "SINGLE_SELECT",
        options: [
          { value: "control", label: "Control" },
          { value: "intervention", label: "Intervention" },
        ],
      },
    ]);

    // only published templates can be versioned
    const draft = await extraction.createTemplate(ctx(owner.id), project.id, { name: uniq("D") });
    await expectAppError(
      extraction.createNewVersion(ctx(owner.id), project.id, draft.id),
      "INVALID_STATE",
    );

    const v2 = await extraction.createNewVersion(ctx(owner.id), project.id, v1.id);
    expect(v2.status).toBe("DRAFT");
    expect(v2.version).toBe(2);
    expect(v2.sourceTemplateId).toBe(v1.id);
    expect(v2.fields.map((f) => f.key).sort()).toEqual(["arm", "outcome"]);

    // clone is editable while the source stays published
    await extraction.createField(ctx(owner.id), project.id, v2.id, {
      key: "timepoint",
      label: "Timepoint",
      type: "TEXT",
    });
    expect((await extraction.getTemplate(ctx(owner.id), project.id, v1.id)).status).toBe("PUBLISHED");

    await extraction.publishTemplate(ctx(owner.id), project.id, v2.id);
    const source = await extraction.getTemplate(ctx(owner.id), project.id, v1.id);
    expect(source.status).toBe("ARCHIVED");
    await prisma.auditEvent.findFirstOrThrow({
      where: { entityType: "ExtractionTemplate", entityId: v2.id, action: "extraction.template.published" },
    });
    const archiveEvent = await prisma.auditEvent.findFirstOrThrow({
      where: {
        entityType: "ExtractionTemplate",
        entityId: v1.id,
        action: "extraction.template.updated",
      },
      orderBy: { createdAt: "desc" },
    });
    expect(archiveEvent.newValue).toMatchObject({ status: "ARCHIVED" });
  });
});

describe("extraction assignments (R15)", () => {
  beforeAll(async () => {
    await resetDb();
  });

  it("bulk-assigns studies × extractors, validates FKs, and skips existing pairs", async () => {
    const { owner, extractorA, extractorB, observer, project } = await setupTeam();
    const template = await makePublishedTemplate(owner.id, project.id, [
      { key: "n", label: "N", type: "NUMBER" },
    ]);
    const study1 = await createStudy(project.id, owner.id);
    const study2 = await createStudy(project.id, owner.id);

    // draft template cannot be assigned
    const draft = await extraction.createTemplate(ctx(owner.id), project.id, { name: uniq("D") });
    await expectAppError(
      extraction.createAssignments(ctx(owner.id), project.id, {
        templateId: draft.id,
        studyIds: [study1.id],
        extractorIds: [extractorA.id],
      }),
      "INVALID_STATE",
    );

    const result = await extraction.createAssignments(ctx(owner.id), project.id, {
      templateId: template.id,
      studyIds: [study1.id, study2.id],
      extractorIds: [extractorA.id, extractorB.id],
    });
    expect(result.created).toHaveLength(4);
    expect(result.skipped).toBe(0);
    await prisma.auditEvent.findFirstOrThrow({
      where: { action: "extraction.assigned", entityId: result.created[0]!.id },
    });

    // skip-existing on re-run
    const rerun = await extraction.createAssignments(ctx(owner.id), project.id, {
      templateId: template.id,
      studyIds: [study1.id, study2.id],
      extractorIds: [extractorA.id, extractorB.id],
    });
    expect(rerun.created).toHaveLength(0);
    expect(rerun.skipped).toBe(4);

    // cross-project study rejected (R9)
    const other = await setupTeam();
    const foreignStudy = await createStudy(other.project.id, other.owner.id);
    await expectAppError(
      extraction.createAssignments(ctx(owner.id), project.id, {
        templateId: template.id,
        studyIds: [foreignStudy.id],
        extractorIds: [extractorA.id],
      }),
      "NOT_FOUND",
    );
    // non-member extractor rejected
    const stranger = await createTestUser();
    await expectAppError(
      extraction.createAssignments(ctx(owner.id), project.id, {
        templateId: template.id,
        studyIds: [study1.id],
        extractorIds: [stranger.id],
      }),
      "NOT_FOUND",
    );
    // member without extraction.perform rejected
    await expectAppError(
      extraction.createAssignments(ctx(owner.id), project.id, {
        templateId: template.id,
        studyIds: [study1.id],
        extractorIds: [observer.id],
      }),
      "VALIDATION",
    );
    // extractors cannot assign
    await expectAppError(
      extraction.createAssignments(ctx(extractorA.id), project.id, {
        templateId: template.id,
        studyIds: [study1.id],
        extractorIds: [extractorB.id],
      }),
      "FORBIDDEN",
    );

    // my-assignments queue: pending only, with study labels
    const mine = await extraction.listAssignments(ctx(extractorA.id), project.id, { mine: true });
    expect(mine).toHaveLength(2);
    expect(mine.map((a) => a.study.label).sort()).toEqual([study1.label, study2.label].sort());
    expect(mine.every((a) => a.status === "PENDING")).toBe(true);
    // full listing requires project.edit
    await expectAppError(
      extraction.listAssignments(ctx(extractorA.id), project.id, { mine: false }),
      "FORBIDDEN",
    );
    expect(await extraction.listAssignments(ctx(owner.id), project.id, { mine: false })).toHaveLength(4);
  });
});

describe("extraction forms & typed values", () => {
  beforeAll(async () => {
    await resetDb();
  });

  it("requires an assignment to start; project.edit holders self-assign implicitly (R15)", async () => {
    const { owner, extractorA, project } = await setupTeam();
    const template = await makePublishedTemplate(owner.id, project.id, [
      { key: "n", label: "N", type: "NUMBER" },
    ]);
    const study = await createStudy(project.id, owner.id);

    // unassigned extractor → FORBIDDEN
    await expectAppError(
      extraction.startForm(ctx(extractorA.id), project.id, study.id, { templateId: template.id }),
      "FORBIDDEN",
    );

    // owner (project.edit) without assignment → implicit self-assign + form
    const ownerStart = await extraction.startForm(ctx(owner.id), project.id, study.id, {
      templateId: template.id,
    });
    expect(ownerStart.created).toBe(true);
    const ownerAssignment = await prisma.extractionAssignment.findUniqueOrThrow({
      where: {
        templateId_studyId_extractorId: {
          templateId: template.id,
          studyId: study.id,
          extractorId: owner.id,
        },
      },
    });
    const selfAssignEvent = await prisma.auditEvent.findFirstOrThrow({
      where: { action: "extraction.assigned", entityId: ownerAssignment.id },
    });
    expect(selfAssignEvent.metadata).toMatchObject({ implicitSelfAssign: true });
    await prisma.auditEvent.findFirstOrThrow({
      where: { entityType: "ExtractionForm", entityId: ownerStart.form.id, action: "extraction.form.started" },
    });

    // once assigned, the extractor can start; restart returns the same form
    await extraction.createAssignments(ctx(owner.id), project.id, {
      templateId: template.id,
      studyIds: [study.id],
      extractorIds: [extractorA.id],
    });
    const first = await extraction.startForm(ctx(extractorA.id), project.id, study.id, {
      templateId: template.id,
    });
    expect(first.created).toBe(true);
    const again = await extraction.startForm(ctx(extractorA.id), project.id, study.id, {
      templateId: template.id,
    });
    expect(again.created).toBe(false);
    expect(again.form.id).toBe(first.form.id);

    // draft templates cannot be extracted against
    const draft = await extraction.createTemplate(ctx(owner.id), project.id, { name: uniq("D") });
    await expectAppError(
      extraction.startForm(ctx(owner.id), project.id, study.id, { templateId: draft.id }),
      "INVALID_STATE",
    );
  });

  it("validates every field type (one valid + one invalid case each)", async () => {
    const { owner, extractorA, project } = await setupTeam();
    const template = await makePublishedTemplate(owner.id, project.id, [
      { key: "f_text", label: "Text", type: "TEXT" },
      { key: "f_textarea", label: "Textarea", type: "TEXTAREA" },
      { key: "f_number", label: "Number", type: "NUMBER" },
      { key: "f_date", label: "Date", type: "DATE" },
      { key: "f_bool", label: "Bool", type: "BOOLEAN" },
      {
        key: "f_single",
        label: "Single",
        type: "SINGLE_SELECT",
        options: [
          { value: "a", label: "A" },
          { value: "b", label: "B" },
        ],
      },
      {
        key: "f_multi",
        label: "Multi",
        type: "MULTI_SELECT",
        options: [
          { value: "x", label: "X" },
          { value: "y", label: "Y" },
        ],
      },
    ]);
    const study = await createStudy(project.id, owner.id);
    await extraction.createAssignments(ctx(owner.id), project.id, {
      templateId: template.id,
      studyIds: [study.id],
      extractorIds: [extractorA.id],
    });
    const { form } = await extraction.startForm(ctx(extractorA.id), project.id, study.id, {
      templateId: template.id,
    });
    const fields = await prisma.extractionField.findMany({ where: { templateId: template.id } });
    const byKey = new Map(fields.map((f) => [f.key, f]));
    const put = (userId: string, key: string, value: unknown) =>
      extraction.upsertValue(ctx(userId), project.id, form.id, byKey.get(key)!.id, { value });

    const matrix: Array<[string, unknown, unknown]> = [
      // [key, valid, invalid]
      ["f_text", "some text", 42],
      ["f_textarea", "longer text", true],
      ["f_number", 12.5, "12.5"],
      ["f_date", "2021-12-31", "2021-02-30"],
      ["f_bool", true, "true"],
      ["f_single", "a", "z"],
      ["f_multi", ["x", "y"], []],
    ];
    for (const [key, valid, invalid] of matrix) {
      const row = await put(extractorA.id, key, valid);
      expect(row?.value).toEqual(valid);
      await expectAppError(put(extractorA.id, key, invalid), "VALIDATION");
    }

    // clearing: value null deletes the row and audits the previous value
    const cleared = await put(extractorA.id, "f_text", null);
    expect(cleared).toBeNull();
    expect(
      await prisma.extractionValue.findUnique({
        where: { formId_fieldId: { formId: form.id, fieldId: byKey.get("f_text")!.id } },
      }),
    ).toBeNull();
    const clearEvent = await prisma.auditEvent.findFirstOrThrow({
      where: { action: "extraction.value.updated", metadata: { path: ["cleared"], equals: true } },
      orderBy: { createdAt: "desc" },
    });
    expect(clearEvent.previousValue).toMatchObject({ value: "some text" });

    // only the extractor writes to their own form — admins included
    await expectAppError(put(owner.id, "f_number", 1), "FORBIDDEN");
    // field must belong to the form's template
    const otherTemplate = await makePublishedTemplate(owner.id, project.id, [
      { key: "elsewhere", label: "Elsewhere", type: "TEXT" },
    ]);
    const foreignField = await prisma.extractionField.findFirstOrThrow({
      where: { templateId: otherTemplate.id },
    });
    await expectAppError(
      extraction.upsertValue(ctx(extractorA.id), project.id, form.id, foreignField.id, {
        value: "x",
      }),
      "NOT_FOUND",
    );
  });

  it("audits value updates with previousValue (integrity rule 6)", async () => {
    const { owner, extractorA, project } = await setupTeam();
    const template = await makePublishedTemplate(owner.id, project.id, [
      { key: "finding", label: "Finding", type: "TEXT" },
    ]);
    const study = await createStudy(project.id, owner.id);
    await extraction.createAssignments(ctx(owner.id), project.id, {
      templateId: template.id,
      studyIds: [study.id],
      extractorIds: [extractorA.id],
    });
    const { form } = await extraction.startForm(ctx(extractorA.id), project.id, study.id, {
      templateId: template.id,
    });
    const field = await prisma.extractionField.findFirstOrThrow({
      where: { templateId: template.id },
    });

    const createdRow = await extraction.upsertValue(ctx(extractorA.id), project.id, form.id, field.id, {
      value: "first",
      sourceQuote: "p. 3, table 1",
      pageNumber: 3,
    });
    await prisma.auditEvent.findFirstOrThrow({
      where: { entityType: "ExtractionValue", entityId: createdRow!.id, action: "extraction.value.created" },
    });

    await extraction.upsertValue(ctx(extractorA.id), project.id, form.id, field.id, {
      value: "second",
    });
    const updateEvent = await prisma.auditEvent.findFirstOrThrow({
      where: { entityType: "ExtractionValue", entityId: createdRow!.id, action: "extraction.value.updated" },
      orderBy: { createdAt: "desc" },
    });
    expect(updateEvent.previousValue).toMatchObject({
      value: "first",
      sourceQuote: "p. 3, table 1",
      pageNumber: 3,
    });
    expect(updateEvent.newValue).toMatchObject({ value: "second" });
  });

  it("blocks completion while required fields are missing, then completes with audit", async () => {
    const { owner, extractorA, project } = await setupTeam();
    const template = await makePublishedTemplate(owner.id, project.id, [
      { key: "req_a", label: "Required A", type: "TEXT", required: true },
      { key: "req_b", label: "Required B", type: "NUMBER", required: true },
      { key: "optional_c", label: "Optional C", type: "TEXT" },
    ]);
    const study = await createStudy(project.id, owner.id);
    await extraction.createAssignments(ctx(owner.id), project.id, {
      templateId: template.id,
      studyIds: [study.id],
      extractorIds: [extractorA.id],
    });
    const { form } = await extraction.startForm(ctx(extractorA.id), project.id, study.id, {
      templateId: template.id,
    });
    const fields = await prisma.extractionField.findMany({ where: { templateId: template.id } });
    const byKey = new Map(fields.map((f) => [f.key, f]));

    const err = await expectAppError(
      extraction.completeForm(ctx(extractorA.id), project.id, form.id),
      "VALIDATION",
    );
    expect(err.details).toMatchObject({ missing: ["req_a", "req_b"] });

    await extraction.upsertValue(ctx(extractorA.id), project.id, form.id, byKey.get("req_a")!.id, {
      value: "filled",
    });
    const err2 = await expectAppError(
      extraction.completeForm(ctx(extractorA.id), project.id, form.id),
      "VALIDATION",
    );
    expect(err2.details).toMatchObject({ missing: ["req_b"] });

    await extraction.upsertValue(ctx(extractorA.id), project.id, form.id, byKey.get("req_b")!.id, {
      value: 42,
    });
    // only the extractor can complete their form
    await expectAppError(extraction.completeForm(ctx(owner.id), project.id, form.id), "FORBIDDEN");
    const completed = await extraction.completeForm(ctx(extractorA.id), project.id, form.id);
    expect(completed.status).toBe("COMPLETED");
    expect(completed.completedAt).not.toBeNull();
    await prisma.auditEvent.findFirstOrThrow({
      where: { entityType: "ExtractionForm", entityId: form.id, action: "extraction.form.completed" },
    });
    // assignment left the extractor's queue
    const mine = await extraction.listAssignments(ctx(extractorA.id), project.id, { mine: true });
    expect(mine).toHaveLength(0);
    // completing twice is rejected
    await expectAppError(
      extraction.completeForm(ctx(extractorA.id), project.id, form.id),
      "INVALID_STATE",
    );
  });
});

describe("dual extraction: conflicts, auto-void, adjudication, locks", () => {
  beforeAll(async () => {
    await resetDb();
  });

  it("runs the full R15/R5-mirror lifecycle", async () => {
    const { owner, extractorA, extractorB, adjudicator, observer, project } = await setupTeam();
    const template = await makePublishedTemplate(owner.id, project.id, [
      { key: "agree_text", label: "Agree", type: "TEXT", required: true },
      { key: "differ_num", label: "Differ", type: "NUMBER" },
      {
        key: "multi",
        label: "Multi",
        type: "MULTI_SELECT",
        options: [
          { value: "x", label: "X" },
          { value: "y", label: "Y" },
        ],
      },
    ]);
    const study = await createStudy(project.id, owner.id);
    await extraction.createAssignments(ctx(owner.id), project.id, {
      templateId: template.id,
      studyIds: [study.id],
      extractorIds: [extractorA.id, extractorB.id],
    });
    const fields = await prisma.extractionField.findMany({ where: { templateId: template.id } });
    const byKey = new Map(fields.map((f) => [f.key, f]));
    const differField = byKey.get("differ_num")!;

    const formA = (
      await extraction.startForm(ctx(extractorA.id), project.id, study.id, { templateId: template.id })
    ).form;
    const formB = (
      await extraction.startForm(ctx(extractorB.id), project.id, study.id, { templateId: template.id })
    ).form;

    const fill = (userId: string, formId: string, key: string, value: unknown) =>
      extraction.upsertValue(ctx(userId), project.id, formId, byKey.get(key)!.id, { value });

    // A: agree "same", differ 1, multi [x,y] — B: agree "same", differ 2, multi [y,x]
    await fill(extractorA.id, formA.id, "agree_text", "same");
    await fill(extractorA.id, formA.id, "differ_num", 1);
    await fill(extractorA.id, formA.id, "multi", ["x", "y"]);
    await fill(extractorB.id, formB.id, "agree_text", "same");
    await fill(extractorB.id, formB.id, "differ_num", 2);
    await fill(extractorB.id, formB.id, "multi", ["y", "x"]);

    await extraction.completeForm(ctx(extractorA.id), project.id, formA.id);
    // one completed form → no conflicts yet
    expect(await prisma.extractionConflict.count({ where: { studyId: study.id } })).toBe(0);

    await extraction.completeForm(ctx(extractorB.id), project.id, formB.id);
    // exactly one conflict: differ_num (agree_text equal; multi equal order-insensitively)
    const conflicts = await prisma.extractionConflict.findMany({ where: { studyId: study.id } });
    expect(conflicts).toHaveLength(1);
    const conflict1 = conflicts[0]!;
    expect(conflict1.fieldId).toBe(differField.id);
    expect(conflict1.status).toBe("OPEN");
    await prisma.auditEvent.findFirstOrThrow({
      where: { entityType: "ExtractionConflict", entityId: conflict1.id, action: "extraction.conflict.opened" },
    });

    // ---- blind rule: extractors see only their own forms; adjudicator/admin see all
    const aForms = await extraction.listForms(ctx(extractorA.id), project.id, { studyId: study.id });
    expect(aForms.map((f) => f.id)).toEqual([formA.id]);
    const adjForms = await extraction.listForms(ctx(adjudicator.id), project.id, { studyId: study.id });
    expect(adjForms.map((f) => f.id).sort()).toEqual([formA.id, formB.id].sort());
    const ownerForms = await extraction.listForms(ctx(owner.id), project.id, { studyId: study.id });
    expect(ownerForms).toHaveLength(2);
    expect(await extraction.listForms(ctx(observer.id), project.id, {})).toHaveLength(0);

    // ---- adjudicator conflict view carries both extractors' values
    await expectAppError(extraction.listConflicts(ctx(extractorA.id), project.id, {}), "FORBIDDEN");
    const list = await extraction.listConflicts(ctx(adjudicator.id), project.id, { status: "OPEN" });
    expect(list).toHaveLength(1);
    const listed = list[0]!;
    expect(listed.field).toMatchObject({ key: "differ_num", type: "NUMBER" });
    expect(listed.study.label).toBe(study.label);
    expect(listed.forms).toHaveLength(2);
    expect(listed.forms.map((f) => f.value).sort()).toEqual([1, 2]);
    expect(listed.forms.map((f) => f.extractor.name).sort()).toEqual(["Extractor A", "Extractor B"]);

    // ---- pre-adjudication edit-to-agree voids the conflict (R6 mirror)
    // non-disputed fields on a completed form stay locked
    await expectAppError(fill(extractorB.id, formB.id, "agree_text", "changed"), "INVALID_STATE");
    // the disputed field stays editable; converging voids the conflict
    await fill(extractorB.id, formB.id, "differ_num", 1);
    const voided = await prisma.extractionConflict.findUniqueOrThrow({
      where: { id: conflict1.id },
    });
    expect(voided.status).toBe("VOIDED");
    // once voided there is no open conflict → the field re-locks
    await expectAppError(fill(extractorB.id, formB.id, "differ_num", 3), "INVALID_STATE");

    // ---- fresh disagreement on a second study → adjudicate → RESOLVED + lock
    const study2 = await createStudy(project.id, owner.id);
    await extraction.createAssignments(ctx(owner.id), project.id, {
      templateId: template.id,
      studyIds: [study2.id],
      extractorIds: [extractorA.id, extractorB.id],
    });
    const formA2 = (
      await extraction.startForm(ctx(extractorA.id), project.id, study2.id, { templateId: template.id })
    ).form;
    const formB2 = (
      await extraction.startForm(ctx(extractorB.id), project.id, study2.id, { templateId: template.id })
    ).form;
    await fill(extractorA.id, formA2.id, "agree_text", "same");
    await fill(extractorA.id, formA2.id, "differ_num", 10);
    await fill(extractorB.id, formB2.id, "agree_text", "same");
    await fill(extractorB.id, formB2.id, "differ_num", 20);
    await extraction.completeForm(ctx(extractorA.id), project.id, formA2.id);
    await extraction.completeForm(ctx(extractorB.id), project.id, formB2.id);
    const conflict2 = await prisma.extractionConflict.findUniqueOrThrow({
      where: { studyId_fieldId: { studyId: study2.id, fieldId: differField.id } },
    });
    expect(conflict2.status).toBe("OPEN");

    // adjudication is capability-gated, type-validated, and OPEN-only
    await expectAppError(
      extraction.adjudicateConflict(ctx(extractorA.id), project.id, conflict2.id, {
        finalValue: 10,
        reason: "not allowed",
      }),
      "FORBIDDEN",
    );
    await expectAppError(
      extraction.adjudicateConflict(ctx(adjudicator.id), project.id, conflict2.id, {
        finalValue: "ten",
        reason: "wrong type",
      }),
      "VALIDATION",
    );
    expect(
      extraction.adjudicateConflictSchema.safeParse({ finalValue: 10, reason: "ab" }).success,
    ).toBe(false);

    const adjudicated = await extraction.adjudicateConflict(ctx(adjudicator.id), project.id, conflict2.id, {
      finalValue: 10,
      reason: "Source table 2 reports 10",
    });
    expect(adjudicated.status).toBe("RESOLVED");
    expect(adjudicated.adjudication.adjudicatorId).toBe(adjudicator.id);
    expect(adjudicated.adjudication.finalValue).toBe(10);
    const adjEvent = await prisma.auditEvent.findFirstOrThrow({
      where: { entityType: "ExtractionConflict", entityId: conflict2.id, action: "extraction.conflict.adjudicated" },
      orderBy: { createdAt: "desc" },
    });
    expect(adjEvent.reason).toBe("Source table 2 reports 10");

    // post-adjudication lock (R5 mirror): both extractors are frozen on that field
    await expectAppError(
      extraction.upsertValue(ctx(extractorA.id), project.id, formA2.id, differField.id, { value: 11 }),
      "INVALID_STATE",
    );
    await expectAppError(
      extraction.upsertValue(ctx(extractorB.id), project.id, formB2.id, differField.id, { value: 10 }),
      "INVALID_STATE",
    );
    // re-adjudication rejected
    await expectAppError(
      extraction.adjudicateConflict(ctx(adjudicator.id), project.id, conflict2.id, {
        finalValue: 20,
        reason: "second thoughts",
      }),
      "INVALID_STATE",
    );
  });

  it("treats a missing value as null when comparing completed forms", async () => {
    const { owner, extractorA, extractorB, project } = await setupTeam();
    const template = await makePublishedTemplate(owner.id, project.id, [
      { key: "maybe_bool", label: "Maybe", type: "BOOLEAN" },
    ]);
    const study = await createStudy(project.id, owner.id);
    await extraction.createAssignments(ctx(owner.id), project.id, {
      templateId: template.id,
      studyIds: [study.id],
      extractorIds: [extractorA.id, extractorB.id],
    });
    const field = await prisma.extractionField.findFirstOrThrow({
      where: { templateId: template.id },
    });
    const formA = (
      await extraction.startForm(ctx(extractorA.id), project.id, study.id, { templateId: template.id })
    ).form;
    const formB = (
      await extraction.startForm(ctx(extractorB.id), project.id, study.id, { templateId: template.id })
    ).form;
    await extraction.upsertValue(ctx(extractorA.id), project.id, formA.id, field.id, { value: true });
    // B leaves the optional field empty
    await extraction.completeForm(ctx(extractorA.id), project.id, formA.id);
    await extraction.completeForm(ctx(extractorB.id), project.id, formB.id);
    const conflictRow = await prisma.extractionConflict.findUniqueOrThrow({
      where: { studyId_fieldId: { studyId: study.id, fieldId: field.id } },
    });
    expect(conflictRow.status).toBe("OPEN");
  });
});
