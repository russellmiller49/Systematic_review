// Reference library: CRUD + dedupe, imports (file + included studies), CSL formatting
// ordering, exports round-trip, external lookup via the fake HTTP client.
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/server/db";
import { AppError } from "@/server/errors";
import { resetHttpClientForTests, setHttpClientForTests } from "@/server/http/client";
import * as references from "@/server/services/references";
import { parseRis } from "@/server/services/imports/parsers/ris";
import { resetDb } from "../db-utils";
import { FakeHttpClient } from "../fake-http-client";
import { createProjectWithTeam, createTestCitation, addProjectMember, createTestUser } from "../factories";

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

const SMITH_CSL = {
  type: "article-journal",
  title: "A reference about valves",
  author: [{ family: "Smith", given: "Jane" }],
  issued: { "date-parts": [[2020]] },
  "container-title": "Chest",
  DOI: "10.1000/ref1",
};

describe("references service", () => {
  beforeAll(async () => {
    await resetDb();
  });

  afterEach(() => {
    resetHttpClientForTests();
  });

  it("creates a reference (audited, csl.id = row id); OBSERVER can read but not write", async () => {
    const { owner, org, project } = await createProjectWithTeam();
    const observer = await createTestUser({ name: "Olly Observer" });
    await prisma.organizationMember.create({
      data: { orgId: org.id, userId: observer.id, role: "MEMBER" },
    });
    await addProjectMember(project.id, observer.id, ["OBSERVER"]);

    const entry = await references.createReference(ctx(owner.id), project.id, {
      csl: SMITH_CSL,
      tags: ["methods"],
      notes: "Key background paper",
    });
    expect(entry.title).toBe("A reference about valves");
    expect(entry.doi).toBe("10.1000/ref1");
    expect(entry.year).toBe(2020);
    expect((entry.csl as { id?: string }).id).toBe(entry.id);

    await prisma.auditEvent.findFirstOrThrow({
      where: { entityType: "ReferenceEntry", entityId: entry.id, action: "reference.created" },
    });

    const list = await references.listReferences(ctx(observer.id), project.id);
    expect(list).toHaveLength(1);
    await expectAppError(
      references.createReference(ctx(observer.id), project.id, { csl: SMITH_CSL }),
      "FORBIDDEN",
    );

    // Duplicate DOI is rejected.
    await expectAppError(
      references.createReference(ctx(owner.id), project.id, {
        csl: { ...SMITH_CSL, title: "Same DOI different title" },
      }),
      "CONFLICT",
    );
  });

  it("update + delete are audited with previous values; tenant scoping enforced", async () => {
    const { owner, project } = await createProjectWithTeam();
    const entry = await references.createReference(ctx(owner.id), project.id, {
      csl: { type: "report", title: "Original title" },
    });

    const updated = await references.updateReference(ctx(owner.id), project.id, entry.id, {
      csl: { type: "report", title: "Renamed title" },
      tags: ["background"],
    });
    expect(updated.title).toBe("Renamed title");
    const updateEvent = await prisma.auditEvent.findFirstOrThrow({
      where: { entityId: entry.id, action: "reference.updated" },
    });
    expect(updateEvent.previousValue).toMatchObject({ title: "Original title" });

    // Cross-project id → NOT_FOUND (R9).
    const other = await createProjectWithTeam();
    await expectAppError(
      references.updateReference(ctx(other.owner.id), other.project.id, entry.id, {
        tags: ["x"],
      }),
      "NOT_FOUND",
    );

    await references.deleteReference(ctx(owner.id), project.id, entry.id);
    expect(await prisma.referenceEntry.count({ where: { id: entry.id } })).toBe(0);
    const deleteEvent = await prisma.auditEvent.findFirstOrThrow({
      where: { entityId: entry.id, action: "reference.deleted" },
    });
    expect(deleteEvent.previousValue).toMatchObject({ title: "Renamed title" });
  });

  it("imports an RIS file with dedupe counts and one audit event", async () => {
    const { owner, project } = await createProjectWithTeam();
    await references.createReference(ctx(owner.id), project.id, {
      csl: { type: "article-journal", title: "Already here", DOI: "10.9/dupe" },
    });
    const ris = [
      "TY  - JOUR",
      "TI  - Fresh import",
      "AU  - Adams, C",
      "PY  - 2019",
      "DO  - 10.9/fresh",
      "ER  - ",
      "TY  - JOUR",
      "TI  - Duplicate import",
      "DO  - 10.9/dupe",
      "ER  - ",
    ].join("\r\n");

    const result = await references.importReferences(ctx(owner.id), project.id, {
      format: "RIS",
      content: ris,
    });
    expect(result).toMatchObject({ added: 1, skipped: 1 });
    const event = await prisma.auditEvent.findFirstOrThrow({
      where: { projectId: project.id, action: "reference.imported" },
    });
    expect(event.metadata).toMatchObject({ format: "RIS", added: 1, skipped: 1 });
  });

  it("mirrors FT-included citations once; second run skips all", async () => {
    const { owner, project } = await createProjectWithTeam();
    const ftStage = await prisma.screeningStage.create({
      data: { projectId: project.id, type: "FULL_TEXT" },
    });
    const included = await createTestCitation(project.id, { doi: "10.5/inc1" });
    const excluded = await createTestCitation(project.id, { doi: "10.5/exc1" });
    await prisma.citationStageResult.create({
      data: { stageId: ftStage.id, citationId: included.id, outcome: "INCLUDE", resolvedVia: "CONSENSUS" },
    });
    await prisma.citationStageResult.create({
      data: { stageId: ftStage.id, citationId: excluded.id, outcome: "EXCLUDE", resolvedVia: "CONSENSUS" },
    });

    const first = await references.addFromCitations(ctx(owner.id), project.id, {});
    expect(first).toMatchObject({ added: 1, skipped: 0 });
    const mirrored = await prisma.referenceEntry.findFirstOrThrow({
      where: { projectId: project.id, citationId: included.id },
    });
    expect(mirrored.tags).toContain("included-study");

    const second = await references.addFromCitations(ctx(owner.id), project.id, {});
    expect(second).toMatchObject({ added: 0, skipped: 1 });
  });

  it("formats bibliographies honoring first-use order for numeric styles", async () => {
    const { owner, project } = await createProjectWithTeam();
    const a = await references.createReference(ctx(owner.id), project.id, {
      csl: {
        type: "article-journal",
        title: "Alpha paper",
        author: [{ family: "Alpha", given: "A" }],
        issued: { "date-parts": [[2018]] },
      },
    });
    const b = await references.createReference(ctx(owner.id), project.id, {
      csl: {
        type: "article-journal",
        title: "Beta paper",
        author: [{ family: "Beta", given: "B" }],
        issued: { "date-parts": [[2019]] },
      },
    });

    // Beta cited first → numbered 1 in Vancouver.
    const bib = await references.formatBibliography(ctx(owner.id), project.id, {
      styleId: "vancouver",
      referenceIds: [b.id, a.id],
    });
    expect(bib.numeric).toBe(true);
    expect(bib.entries.map((e) => e.referenceId)).toEqual([b.id, a.id]);
    expect(bib.entries[0]!.text).toContain("Beta");

    // No formatting audit events (unaudited read).
    expect(
      await prisma.auditEvent.count({
        where: { projectId: project.id, action: { startsWith: "reference." }, NOT: { action: "reference.created" } },
      }),
    ).toBe(0);
  });

  it("exports RIS that re-parses with matching titles (audited)", async () => {
    const { owner, project } = await createProjectWithTeam();
    await references.createReference(ctx(owner.id), project.id, {
      csl: SMITH_CSL,
    });
    const out = await references.exportReferences(ctx(owner.id), project.id, { format: "ris" });
    expect(out.filename).toBe("references.ris");
    const { records, errors } = parseRis(out.body);
    expect(errors).toHaveLength(0);
    expect(records.map((r) => r.title)).toContain("A reference about valves");
    await prisma.auditEvent.findFirstOrThrow({
      where: { projectId: project.id, action: "reference.exported" },
    });
  });

  it("looks up a DOI via Crossref (fake http) and flags duplicates", async () => {
    const { owner, project } = await createProjectWithTeam();
    setHttpClientForTests(
      new FakeHttpClient().on("api.crossref.org/works/10.1136", {
        json: {
          message: {
            type: "journal-article",
            title: ["The PRISMA 2020 statement"],
            "container-title": ["BMJ"],
            author: [{ family: "Page", given: "Matthew J" }],
            issued: { "date-parts": [[2021]] },
            DOI: "10.1136/bmj.n71",
          },
        },
      }),
    );

    const lookup = await references.lookupReference(ctx(owner.id), project.id, {
      kind: "doi",
      value: "https://doi.org/10.1136/bmj.n71",
    });
    expect(lookup.csl.title).toBe("The PRISMA 2020 statement");
    expect(lookup.duplicateOfId).toBeNull();

    await references.createReference(ctx(owner.id), project.id, { csl: lookup.csl });
    const again = await references.lookupReference(ctx(owner.id), project.id, {
      kind: "doi",
      value: "10.1136/bmj.n71",
    });
    expect(again.duplicateOfId).not.toBeNull();
  });
});
