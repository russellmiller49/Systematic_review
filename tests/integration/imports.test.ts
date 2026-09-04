// Integration: import flow (sources → parse/preview → commit → citations) + citations reads.
// Run against your own database: srb_test_imports (see agent sandbox instructions).
import { beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/server/db";
import { AppError } from "@/server/errors";
import * as imports from "@/server/services/imports";
import * as citations from "@/server/services/citations";
import * as dedup from "@/server/services/dedup";
import { resetDb } from "../db-utils";
import {
  addOrgMember,
  addProjectMember,
  createProjectWithTeam,
  createTestCitation,
  createTestProject,
  createTestUser,
  uniq,
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

// 2 good records + 1 missing its title (row 2).
const RIS_TWO_GOOD_ONE_BAD = `TY  - JOUR
TI  - Endobronchial valve therapy outcomes in severe emphysema
AU  - Criner, Gerard J.
AU  - Sue, Richard
PY  - 2018/09/15
JF  - American Journal of Respiratory and Critical Care Medicine
VL  - 198
IS  - 9
SP  - 1151
EP  - 1164
AB  - RATIONALE: first line of the abstract
      continued on a second line.
DO  - https://doi.org/10.1164/RCCM.201803-0590OC
UR  - https://pubmed.ncbi.nlm.nih.gov/29787288/
LA  - eng
ER  -

TY  - JOUR
AU  - Titleless, Terry
PY  - 2019
JO  - Journal of Missing Fields
ER  -

TY  - JOUR
TI  - Diaphragm ultrasound reproducibility in COPD
AU  - Müller, Jürgen
PY  - 2020
JO  - Thorax
DO  - 10.1136/thoraxjnl-2019-213456
ER  -
`;

const CSV_TWO_ROWS = `Title,Authors,Year,Journal,DOI,PMID,URL
"Telehealth pulmonary rehabilitation meta-analysis","Lee, Annemarie L.; Cox, Narelle",2022,Chest,10.1016/j.chest.2022.01.041,35143823,https://example.org/telehealth
"Smoking cessation in pulmonary clinics","Nguyen, Thi Hoang Lan",2021,Respiratory Research,,PMID: 34059074,
`;

async function setupProject() {
  const team = await createProjectWithTeam();
  const source = await imports.createImportSource(ctx(team.owner.id), team.project.id, {
    name: uniq("PubMed"),
  });
  return { ...team, source };
}

describe("imports + citations", () => {
  beforeAll(async () => {
    await resetDb();
  });

  describe("import sources", () => {
    it("creates a source (audited), rejects duplicate names with 409", async () => {
      const { owner, project } = await createProjectWithTeam();
      const name = uniq("Embase");
      const source = await imports.createImportSource(ctx(owner.id), project.id, { name });
      expect(source.name).toBe(name);

      const event = await prisma.auditEvent.findFirstOrThrow({
        where: { entityType: "ImportSource", entityId: source.id },
      });
      expect(event.userId).toBe(owner.id);

      await expectAppError(
        imports.createImportSource(ctx(owner.id), project.id, { name }),
        "CONFLICT",
      );
    });

    it("reviewers can list but not mutate sources", async () => {
      const { owner, reviewer1, project } = await createProjectWithTeam();
      await imports.createImportSource(ctx(owner.id), project.id, { name: uniq("CENTRAL") });

      const listed = await imports.listImportSources(ctx(reviewer1.id), project.id);
      expect(listed.length).toBeGreaterThan(0);

      await expectAppError(
        imports.createImportSource(ctx(reviewer1.id), project.id, { name: uniq("Nope") }),
        "FORBIDDEN",
      );
    });

    it("updates and deletes sources; delete is blocked once batches exist", async () => {
      const { owner, project, source } = await setupProject();
      const renamed = await imports.updateImportSource(ctx(owner.id), project.id, source.id, {
        name: uniq("Renamed"),
      });
      expect(renamed.name).toMatch(/^Renamed/);

      await imports.createBatch(ctx(owner.id), project.id, {
        filename: "search.ris",
        sourceId: source.id,
        content: RIS_TWO_GOOD_ONE_BAD,
      });
      await expectAppError(
        imports.deleteImportSource(ctx(owner.id), project.id, source.id),
        "CONFLICT",
      );

      const empty = await imports.createImportSource(ctx(owner.id), project.id, {
        name: uniq("Empty"),
      });
      await imports.deleteImportSource(ctx(owner.id), project.id, empty.id);
      expect(
        await prisma.importSource.findUnique({ where: { id: empty.id } }),
      ).toBeNull();
    });
  });

  describe("import flow (RIS end-to-end)", () => {
    it("upload → preview rows (incl. malformed) → commit → citations + identifiers + audit", async () => {
      const { owner, project, source } = await setupProject();

      // Step 1: create batch (format auto-detected from filename)
      const batch = await imports.createBatch(ctx(owner.id), project.id, {
        filename: "pubmed-search.ris",
        sourceId: source.id,
        content: RIS_TWO_GOOD_ONE_BAD,
      });
      expect(batch.status).toBe("PREVIEWED");
      expect(batch.format).toBe("RIS");
      expect(batch.totalRecords).toBe(3);
      expect(batch.parsedRecords).toBe(2);
      expect(batch.failedRecords).toBe(1);
      expect(batch.source.id).toBe(source.id);

      const createdEvent = await prisma.auditEvent.findFirstOrThrow({
        where: { entityType: "ImportBatch", entityId: batch.id, action: "import.batch.created" },
      });
      expect(createdEvent.metadata).toMatchObject({ totalRecords: 3, failedRecords: 1 });

      // Preview: every row preserved, including the failed one
      const preview = await imports.getBatch(ctx(owner.id), project.id, batch.id);
      expect(preview.rows).toHaveLength(3);
      const failedRow = preview.rows.find((r) => r.parseErrors !== null)!;
      expect(failedRow.rowNumber).toBe(2);
      expect(failedRow.parsed).toBeNull();
      expect(failedRow.citationId).toBeNull();
      expect(failedRow.rawRecord).toContain("Titleless, Terry");
      const goodRow = preview.rows.find((r) => r.rowNumber === 1)!;
      expect(goodRow.parsed).toMatchObject({
        title: "Endobronchial valve therapy outcomes in severe emphysema",
        year: 2018,
      });

      // Step 2: commit
      const committed = await imports.commitBatch(ctx(owner.id), project.id, batch.id);
      expect(committed.status).toBe("COMMITTED");
      expect(committed.committedAt).toBeInstanceOf(Date);
      expect(committed.citationsCreated).toBe(2);

      // Citations with normalized fields
      const cite1 = await prisma.citation.findFirstOrThrow({
        where: { projectId: project.id, doi: "10.1164/rccm.201803-0590oc" },
        include: { identifiers: true, sourceRecords: true },
      });
      expect(cite1.title).toBe("Endobronchial valve therapy outcomes in severe emphysema");
      expect(cite1.normalizedTitle).toBe(
        "endobronchial valve therapy outcomes in severe emphysema",
      );
      expect(cite1.year).toBe(2018);
      expect(cite1.pages).toBe("1151-1164");
      expect(cite1.abstract).toBe(
        "RATIONALE: first line of the abstract continued on a second line.",
      );
      expect(cite1.authors).toEqual([
        { family: "Criner", given: "Gerard J.", raw: "Criner, Gerard J." },
        { family: "Sue", given: "Richard", raw: "Sue, Richard" },
      ]);
      const idTypes = cite1.identifiers.map((i) => [i.type, i.value]);
      expect(idTypes).toContainEqual(["DOI", "10.1164/rccm.201803-0590oc"]);
      expect(idTypes).toContainEqual(["URL", "https://pubmed.ncbi.nlm.nih.gov/29787288/"]);

      // Source records linked to citations (parsed rows only)
      expect(cite1.sourceRecords).toHaveLength(1);
      expect(cite1.sourceRecords[0]!.batchId).toBe(batch.id);
      const rowsAfter = await prisma.citationSourceRecord.findMany({
        where: { batchId: batch.id },
      });
      expect(rowsAfter.filter((r) => r.citationId !== null)).toHaveLength(2);
      expect(rowsAfter.filter((r) => r.citationId === null)).toHaveLength(1);

      // Audit for commit
      const commitEvent = await prisma.auditEvent.findFirstOrThrow({
        where: {
          entityType: "ImportBatch",
          entityId: batch.id,
          action: "import.batch.committed",
        },
      });
      expect(commitEvent.metadata).toMatchObject({ citationsCreated: 2 });

      // Idempotency guard: second commit → 422
      await expectAppError(
        imports.commitBatch(ctx(owner.id), project.id, batch.id),
        "INVALID_STATE",
      );
    });

    it("rejects createBatch with a source from another project (R9)", async () => {
      const { owner, project } = await setupProject();
      const other = await setupProject();
      await expectAppError(
        imports.createBatch(ctx(owner.id), project.id, {
          filename: "search.ris",
          sourceId: other.source.id,
          content: RIS_TWO_GOOD_ONE_BAD,
        }),
        "NOT_FOUND",
      );
    });

    it("rejects undetectable formats with 422", async () => {
      const { owner, project, source } = await setupProject();
      await expectAppError(
        imports.createBatch(ctx(owner.id), project.id, {
          filename: "notes.txt",
          sourceId: source.id,
          content: "prose without any structure",
        }),
        "INVALID_STATE",
      );
    });

    it("rejects files over 20 MB with 422", async () => {
      const { owner, project, source } = await setupProject();
      await expectAppError(
        imports.createBatch(ctx(owner.id), project.id, {
          filename: "huge.ris",
          sourceId: source.id,
          content: "x".repeat(imports.MAX_IMPORT_BYTES + 1),
        }),
        "INVALID_STATE",
      );
    });

    it("reviewers cannot create or commit batches", async () => {
      const { owner, reviewer1, project, source } = await setupProject();
      await expectAppError(
        imports.createBatch(ctx(reviewer1.id), project.id, {
          filename: "search.ris",
          sourceId: source.id,
          content: RIS_TWO_GOOD_ONE_BAD,
        }),
        "FORBIDDEN",
      );
      const batch = await imports.createBatch(ctx(owner.id), project.id, {
        filename: "search.ris",
        sourceId: source.id,
        content: RIS_TWO_GOOD_ONE_BAD,
      });
      await expectAppError(
        imports.commitBatch(ctx(reviewer1.id), project.id, batch.id),
        "FORBIDDEN",
      );
      // but they can read batches (project.view)
      const listed = await imports.listBatches(ctx(reviewer1.id), project.id);
      expect(listed.map((b) => b.id)).toContain(batch.id);
    });
  });

  describe("cohort capture (affiliations + REGISTRY_ID identifiers)", () => {
    // NBIB with AD affiliations, an SI registry id, and an EudraCT id in the abstract.
    const NBIB_WITH_COHORT = `PMID- 40000001
DP  - 2018 Nov 1
TI  - Endobronchial valve trial with registry ids.
AB  - A randomized trial (EudraCT 2016-001234-56).
AD  - Temple University, Philadelphia, PA, USA.
AD  - St. Joseph's Hospital, Phoenix, AZ, USA.
SI  - ClinicalTrials.gov/NCT01796392
FAU - Criner, Gerard J
AU  - Criner GJ
JT  - Am J Respir Crit Care Med
`;

    it("commit persists affiliations to the citation and REGISTRY_ID identifier rows", async () => {
      const { owner, project, source } = await setupProject();
      const batch = await imports.createBatch(ctx(owner.id), project.id, {
        filename: "cohort.nbib",
        sourceId: source.id,
        content: NBIB_WITH_COHORT,
      });
      expect(batch.format).toBe("NBIB");
      await imports.commitBatch(ctx(owner.id), project.id, batch.id);

      const cite = await prisma.citation.findFirstOrThrow({
        where: { projectId: project.id, pmid: "40000001" },
        include: { identifiers: true },
      });
      expect(cite.affiliations).toEqual([
        "Temple University, Philadelphia, PA, USA.",
        "St. Joseph's Hospital, Phoenix, AZ, USA.",
      ]);
      const registryIds = cite.identifiers
        .filter((i) => i.type === "REGISTRY_ID")
        .map((i) => i.value)
        .sort();
      // NCT from SI + EudraCT from the abstract, canonical + sorted.
      expect(registryIds).toEqual(["EUDRACT2016-001234-56", "NCT01796392"]);
    });

    it("CSV records (no cohort tags) leave affiliations null and create no REGISTRY_ID rows", async () => {
      const { owner, project, source } = await setupProject();
      const batch = await imports.createBatch(ctx(owner.id), project.id, {
        filename: "handsearch.csv",
        sourceId: source.id,
        content: CSV_TWO_ROWS,
      });
      await imports.commitBatch(ctx(owner.id), project.id, batch.id);
      const cite = await prisma.citation.findFirstOrThrow({
        where: { projectId: project.id, pmid: "34059074" },
        include: { identifiers: true },
      });
      expect(cite.affiliations).toBeNull();
      expect(cite.identifiers.some((i) => i.type === "REGISTRY_ID")).toBe(false);
    });
  });

  describe("import flow (CSV)", () => {
    it("imports CSV with PMID identifiers", async () => {
      const { owner, project, source } = await setupProject();
      const batch = await imports.createBatch(ctx(owner.id), project.id, {
        filename: "handsearch.csv",
        sourceId: source.id,
        content: CSV_TWO_ROWS,
      });
      expect(batch.format).toBe("CSV");
      expect(batch.parsedRecords).toBe(2);
      expect(batch.failedRecords).toBe(0);

      const committed = await imports.commitBatch(ctx(owner.id), project.id, batch.id);
      expect(committed.citationsCreated).toBe(2);

      const cite = await prisma.citation.findFirstOrThrow({
        where: { projectId: project.id, pmid: "34059074" },
        include: { identifiers: true },
      });
      expect(cite.title).toBe("Smoking cessation in pulmonary clinics");
      expect(cite.identifiers.map((i) => [i.type, i.value])).toContainEqual([
        "PMID",
        "34059074",
      ]);
    });
  });

  describe("deleting import batches", () => {
    it("deletes an uncommitted preview with its source records and audits the rollback", async () => {
      const { owner, project, source } = await setupProject();
      const batch = await imports.createBatch(ctx(owner.id), project.id, {
        filename: "preview-only.csv",
        sourceId: source.id,
        content: CSV_TWO_ROWS,
      });

      const result = await imports.deleteBatch(ctx(owner.id), project.id, batch.id);
      expect(result).toEqual({
        id: batch.id,
        citationsDeleted: 0,
        citationsRetained: 0,
        ownerOverride: false,
        screeningHistoryDeleted: {
          assignments: 0,
          decisions: 0,
          conflicts: 0,
          adjudications: 0,
          stageResults: 0,
          aiSuggestions: 0,
        },
        deduplicationHistoryDeleted: {
          candidates: 0,
          groups: 0,
          retainedCitationsRestored: 0,
          assignmentsRestored: 0,
          conflictsRestored: 0,
        },
      });
      expect(await prisma.importBatch.findUnique({ where: { id: batch.id } })).toBeNull();
      expect(await prisma.citationSourceRecord.count({ where: { batchId: batch.id } })).toBe(0);

      const event = await prisma.auditEvent.findFirstOrThrow({
        where: {
          entityType: "ImportBatch",
          entityId: batch.id,
          action: "import.batch.deleted",
        },
      });
      expect(event.previousValue).toMatchObject({
        filename: "preview-only.csv",
        status: "PREVIEWED",
      });
    });

    it("deletes a committed import and its untouched citations", async () => {
      const { owner, project, source } = await setupProject();
      const batch = await imports.createBatch(ctx(owner.id), project.id, {
        filename: "rollback.csv",
        sourceId: source.id,
        content: CSV_TWO_ROWS,
      });
      await imports.commitBatch(ctx(owner.id), project.id, batch.id);
      const citationIds = (
        await prisma.citationSourceRecord.findMany({
          where: { batchId: batch.id, citationId: { not: null } },
          select: { citationId: true },
        })
      ).map((row) => row.citationId!);
      expect(citationIds).toHaveLength(2);

      const result = await imports.deleteBatch(ctx(owner.id), project.id, batch.id);
      expect(result.citationsDeleted).toBe(2);
      expect(result.citationsRetained).toBe(0);
      expect(await prisma.importBatch.findUnique({ where: { id: batch.id } })).toBeNull();
      expect(await prisma.citation.count({ where: { id: { in: citationIds } } })).toBe(0);
      expect(await prisma.citationIdentifier.count({ where: { citationId: { in: citationIds } } })).toBe(0);
    });

    it("blocks committed deletion after downstream screening work and forbids reviewers", async () => {
      const { owner, reviewer1, project, source } = await setupProject();
      const batch = await imports.createBatch(ctx(owner.id), project.id, {
        filename: "screened.csv",
        sourceId: source.id,
        content: CSV_TWO_ROWS,
      });
      await imports.commitBatch(ctx(owner.id), project.id, batch.id);

      await expectAppError(
        imports.deleteBatch(ctx(reviewer1.id), project.id, batch.id),
        "FORBIDDEN",
      );

      const citation = await prisma.citation.findFirstOrThrow({ where: { projectId: project.id } });
      const stage = await prisma.screeningStage.create({
        data: { projectId: project.id, type: "TITLE_ABSTRACT" },
      });
      await prisma.screeningAssignment.create({
        data: { stageId: stage.id, citationId: citation.id, reviewerId: reviewer1.id },
      });

      await expectAppError(imports.deleteBatch(ctx(owner.id), project.id, batch.id), "INVALID_STATE");
      expect(await prisma.importBatch.findUnique({ where: { id: batch.id } })).not.toBeNull();
      expect(await prisma.citation.findUnique({ where: { id: citation.id } })).not.toBeNull();
    });

    it("lets only an owner confirm deletion of an import and its screening history", async () => {
      const { owner, reviewer1, reviewer2, adjudicator, org, project, source } =
        await setupProject();
      const batch = await imports.createBatch(ctx(owner.id), project.id, {
        filename: "accidental-screened.csv",
        sourceId: source.id,
        content: CSV_TWO_ROWS,
      });
      await imports.commitBatch(ctx(owner.id), project.id, batch.id);

      const citation = await prisma.citation.findFirstOrThrow({
        where: { projectId: project.id, pmid: "35143823" },
      });
      const stage = await prisma.screeningStage.create({
        data: { projectId: project.id, type: "TITLE_ABSTRACT" },
      });
      await prisma.screeningAssignment.createMany({
        data: [reviewer1.id, reviewer2.id].map((reviewerId) => ({
          stageId: stage.id,
          citationId: citation.id,
          reviewerId,
          status: "COMPLETED" as const,
        })),
      });
      await prisma.screeningDecision.createMany({
        data: [
          {
            stageId: stage.id,
            citationId: citation.id,
            reviewerId: reviewer1.id,
            decision: "INCLUDE",
            labels: [],
          },
          {
            stageId: stage.id,
            citationId: citation.id,
            reviewerId: reviewer2.id,
            decision: "EXCLUDE",
            labels: [],
          },
        ],
      });
      const conflict = await prisma.screeningConflict.create({
        data: {
          stageId: stage.id,
          citationId: citation.id,
          status: "RESOLVED",
          resolvedAt: new Date(),
        },
      });
      await prisma.screeningAdjudication.create({
        data: {
          conflictId: conflict.id,
          adjudicatorId: adjudicator.id,
          finalDecision: "EXCLUDE",
          reason: "Resolved before the import mistake was found",
        },
      });
      await prisma.citationStageResult.create({
        data: {
          stageId: stage.id,
          citationId: citation.id,
          outcome: "EXCLUDE",
          resolvedVia: "ADJUDICATION",
        },
      });
      const aiRun = await prisma.aiScreeningRun.create({
        data: {
          projectId: project.id,
          stageId: stage.id,
          status: "COMPLETED",
          provider: "test",
          model: "test-model",
          promptVersion: "test-v1",
          totalCount: 1,
          succeededCount: 1,
          requestedById: owner.id,
          completedAt: new Date(),
        },
      });
      await prisma.screeningSuggestion.create({
        data: {
          stageId: stage.id,
          citationId: citation.id,
          runId: aiRun.id,
          score: 50,
          suggestedDecision: "MAYBE",
          rationale: "Test suggestion",
          provider: "test",
          model: "test-model",
          promptVersion: "test-v1",
        },
      });

      const librarian = await createTestUser({ name: "Librarian" });
      await addOrgMember(org.id, librarian.id);
      await addProjectMember(project.id, librarian.id, ["LIBRARIAN"]);
      await expectAppError(
        imports.ownerDeleteBatchWithScreeningHistory(
          ctx(librarian.id),
          project.id,
          batch.id,
          {
            confirmation: batch.filename,
            reason: "Accidental import",
          },
        ),
        "FORBIDDEN",
      );
      await expectAppError(
        imports.getOwnerDeleteBatchPreview(ctx(librarian.id), project.id, batch.id),
        "FORBIDDEN",
      );
      await expectAppError(
        imports.ownerDeleteBatchWithScreeningHistory(ctx(owner.id), project.id, batch.id, {
          confirmation: "wrong filename.csv",
          reason: "Accidental import",
        }),
        "INVALID_STATE",
      );

      const result = await imports.ownerDeleteBatchWithScreeningHistory(
        ctx(owner.id),
        project.id,
        batch.id,
        {
          confirmation: batch.filename,
          reason: "Accidental import",
        },
      );
      expect(result).toMatchObject({
        id: batch.id,
        citationsDeleted: 2,
        citationsRetained: 0,
        ownerOverride: true,
        screeningHistoryDeleted: {
          assignments: 2,
          decisions: 2,
          conflicts: 1,
          adjudications: 1,
          stageResults: 1,
          aiSuggestions: 1,
        },
      });
      expect(await prisma.citation.count({ where: { projectId: project.id } })).toBe(0);
      expect(await prisma.screeningAssignment.count({ where: { stageId: stage.id } })).toBe(0);
      expect(await prisma.screeningDecision.count({ where: { stageId: stage.id } })).toBe(0);
      expect(await prisma.screeningConflict.count({ where: { stageId: stage.id } })).toBe(0);
      expect(await prisma.citationStageResult.count({ where: { stageId: stage.id } })).toBe(0);
      expect(await prisma.screeningSuggestion.count({ where: { stageId: stage.id } })).toBe(0);
      expect(await prisma.aiScreeningRun.findUnique({ where: { id: aiRun.id } })).not.toBeNull();

      const event = await prisma.auditEvent.findFirstOrThrow({
        where: {
          entityType: "ImportBatch",
          entityId: batch.id,
          action: "import.batch.deleted",
        },
        orderBy: { createdAt: "desc" },
      });
      expect(event.reason).toBe("Accidental import");
      expect(event.metadata).toMatchObject({
        ownerOverride: true,
        screeningHistoryDeleted: { decisions: 2, adjudications: 1 },
      });
    });

    it("rolls back deduplication while preserving records from other imports", async () => {
      const { owner, reviewer1, project, source } = await setupProject();
      const originalBatch = await imports.createBatch(ctx(owner.id), project.id, {
        filename: "original.csv",
        sourceId: source.id,
        content: CSV_TWO_ROWS,
      });
      const mistakenBatch = await imports.createBatch(ctx(owner.id), project.id, {
        filename: "mistaken.csv",
        sourceId: source.id,
        content: CSV_TWO_ROWS,
      });
      await imports.commitBatch(ctx(owner.id), project.id, originalBatch.id);
      await imports.commitBatch(ctx(owner.id), project.id, mistakenBatch.id);

      const [originalFirst, originalSecond, mistakenFirst, mistakenSecond] = await Promise.all([
        prisma.citation.findFirstOrThrow({
          where: { pmid: "35143823", sourceRecords: { some: { batchId: originalBatch.id } } },
        }),
        prisma.citation.findFirstOrThrow({
          where: { pmid: "34059074", sourceRecords: { some: { batchId: originalBatch.id } } },
        }),
        prisma.citation.findFirstOrThrow({
          where: { pmid: "35143823", sourceRecords: { some: { batchId: mistakenBatch.id } } },
        }),
        prisma.citation.findFirstOrThrow({
          where: { pmid: "34059074", sourceRecords: { some: { batchId: mistakenBatch.id } } },
        }),
      ]);
      const stage = await prisma.screeningStage.create({
        data: { projectId: project.id, type: "TITLE_ABSTRACT" },
      });
      const retainedAssignment = await prisma.screeningAssignment.create({
        data: { stageId: stage.id, citationId: originalFirst.id, reviewerId: reviewer1.id },
      });

      async function createPairGroup(citationOneId: string, citationTwoId: string) {
        const group = await prisma.deduplicationGroup.create({
          data: { projectId: project.id },
        });
        const orderedCitationIds = [citationOneId, citationTwoId].sort();
        await prisma.deduplicationCandidate.create({
          data: {
            projectId: project.id,
            groupId: group.id,
            citationAId: orderedCitationIds[0]!,
            citationBId: orderedCitationIds[1]!,
            method: "EXACT_PMID",
            score: 1,
            reasons: { matchedFields: ["pmid"] },
          },
        });
        return group;
      }

      const retainedBecomesDuplicate = await createPairGroup(originalFirst.id, mistakenFirst.id);
      await dedup.mergeGroup(ctx(owner.id), project.id, retainedBecomesDuplicate.id, {
        canonicalCitationId: mistakenFirst.id,
      });
      const mistakenBecomesDuplicate = await createPairGroup(originalSecond.id, mistakenSecond.id);
      await dedup.mergeGroup(ctx(owner.id), project.id, mistakenBecomesDuplicate.id, {
        canonicalCitationId: originalSecond.id,
      });

      expect(
        (await prisma.screeningAssignment.findUniqueOrThrow({
          where: { id: retainedAssignment.id },
        })).status,
      ).toBe("VOIDED");

      const preview = await imports.getOwnerDeleteBatchPreview(
        ctx(owner.id),
        project.id,
        mistakenBatch.id,
      );
      expect(preview).toMatchObject({
        canDelete: true,
        citationsToDelete: 2,
        citationsRetained: 0,
        deduplication: {
          citationsWithRelationships: 2,
          candidates: 2,
          groups: 2,
          retainedCitationsToRestore: 1,
        },
        blockers: [],
      });

      const result = await imports.ownerDeleteBatchWithScreeningHistory(
        ctx(owner.id),
        project.id,
        mistakenBatch.id,
        { confirmation: mistakenBatch.filename, reason: "Accidental duplicate import" },
      );
      expect(result.deduplicationHistoryDeleted).toEqual({
        candidates: 2,
        groups: 2,
        retainedCitationsRestored: 1,
        assignmentsRestored: 1,
        conflictsRestored: 0,
      });
      expect(await prisma.citation.findUnique({ where: { id: mistakenFirst.id } })).toBeNull();
      expect(await prisma.citation.findUnique({ where: { id: mistakenSecond.id } })).toBeNull();
      await expect(
        prisma.citation.findUniqueOrThrow({ where: { id: originalFirst.id } }),
      ).resolves.toMatchObject({ status: "ACTIVE", duplicateOfId: null });
      await expect(
        prisma.citation.findUniqueOrThrow({ where: { id: originalSecond.id } }),
      ).resolves.toMatchObject({ status: "ACTIVE", duplicateOfId: null });
      expect(
        (await prisma.screeningAssignment.findUniqueOrThrow({
          where: { id: retainedAssignment.id },
        })).status,
      ).toBe("PENDING");
      expect(
        await prisma.deduplicationCandidate.count({
          where: { groupId: { in: [retainedBecomesDuplicate.id, mistakenBecomesDuplicate.id] } },
        }),
      ).toBe(0);
      expect(
        await prisma.deduplicationGroup.count({
          where: { id: { in: [retainedBecomesDuplicate.id, mistakenBecomesDuplicate.id] } },
        }),
      ).toBe(0);
      await prisma.auditEvent.findFirstOrThrow({
        where: {
          projectId: project.id,
          entityType: "Citation",
          entityId: originalFirst.id,
          action: "dedup.merge_undone",
        },
      });
    });

    it("keeps work beyond screening as a blocker for the owner override", async () => {
      const { owner, project, source } = await setupProject();
      const batch = await imports.createBatch(ctx(owner.id), project.id, {
        filename: "study-linked.csv",
        sourceId: source.id,
        content: CSV_TWO_ROWS,
      });
      await imports.commitBatch(ctx(owner.id), project.id, batch.id);
      const citation = await prisma.citation.findFirstOrThrow({
        where: { projectId: project.id },
      });
      const study = await prisma.study.create({
        data: {
          projectId: project.id,
          label: "Downstream study",
          createdById: owner.id,
        },
      });
      await prisma.studyReportLink.create({
        data: { studyId: study.id, citationId: citation.id, isPrimaryReport: true },
      });

      const preview = await imports.getOwnerDeleteBatchPreview(
        ctx(owner.id),
        project.id,
        batch.id,
      );
      expect(preview.canDelete).toBe(false);
      expect(preview.blockers).toEqual([
        {
          kind: "STUDY_LINK",
          label: "linked studies",
          count: 1,
          citations: [{ id: citation.id, title: citation.title }],
        },
      ]);

      await expectAppError(
        imports.ownerDeleteBatchWithScreeningHistory(ctx(owner.id), project.id, batch.id, {
          confirmation: batch.filename,
          reason: "Accidental import",
        }),
        "INVALID_STATE",
      );
      expect(await prisma.importBatch.findUnique({ where: { id: batch.id } })).not.toBeNull();
      expect(await prisma.citation.findUnique({ where: { id: citation.id } })).not.toBeNull();
    });
  });

  describe("citations list & detail", () => {
    it("filters by q, batchId and status; paginates with a cursor", async () => {
      const { owner, project, source } = await setupProject();
      const risBatch = await imports.createBatch(ctx(owner.id), project.id, {
        filename: "search.ris",
        sourceId: source.id,
        content: RIS_TWO_GOOD_ONE_BAD,
      });
      await imports.commitBatch(ctx(owner.id), project.id, risBatch.id);
      const csvBatch = await imports.createBatch(ctx(owner.id), project.id, {
        filename: "handsearch.csv",
        sourceId: source.id,
        content: CSV_TWO_ROWS,
      });
      await imports.commitBatch(ctx(owner.id), project.id, csvBatch.id);

      // default: all ACTIVE citations, with identifiers and source names
      const all = await citations.listCitations(ctx(owner.id), project.id, {
        status: "ACTIVE",
        limit: 50,
      });
      expect(all.items).toHaveLength(4);
      expect(all.nextCursor).toBeNull();
      const withDoi = all.items.find((c) => c.doi === "10.1136/thoraxjnl-2019-213456")!;
      expect(withDoi.identifiers.map((i) => i.type)).toContain("DOI");
      expect(withDoi.sources.map((s) => s.id)).toContain(source.id);

      // q: case-insensitive title contains
      const searched = await citations.listCitations(ctx(owner.id), project.id, {
        status: "ACTIVE",
        q: "diaphragm ULTRASOUND",
        limit: 50,
      });
      expect(searched.items).toHaveLength(1);
      expect(searched.items[0]!.title).toBe("Diaphragm ultrasound reproducibility in COPD");

      // batchId filter
      const fromCsv = await citations.listCitations(ctx(owner.id), project.id, {
        status: "ACTIVE",
        batchId: csvBatch.id,
        limit: 50,
      });
      expect(fromCsv.items).toHaveLength(2);

      // cursor pagination
      const page1 = await citations.listCitations(ctx(owner.id), project.id, {
        status: "ACTIVE",
        limit: 3,
      });
      expect(page1.items).toHaveLength(3);
      expect(page1.nextCursor).toBe(page1.items[2]!.id);
      const page2 = await citations.listCitations(ctx(owner.id), project.id, {
        status: "ACTIVE",
        limit: 3,
        cursor: page1.nextCursor!,
      });
      expect(page2.items).toHaveLength(1);
      expect(page2.nextCursor).toBeNull();
      expect(new Set([...page1.items, ...page2.items].map((c) => c.id)).size).toBe(4);

      // status filter: mark one as DUPLICATE
      const dupe = all.items[0]!;
      await prisma.citation.update({
        where: { id: dupe.id },
        data: { status: "DUPLICATE", duplicateOfId: all.items[1]!.id },
      });
      const active = await citations.listCitations(ctx(owner.id), project.id, {
        status: "ACTIVE",
        limit: 50,
      });
      expect(active.items.map((c) => c.id)).not.toContain(dupe.id);
      const duplicates = await citations.listCitations(ctx(owner.id), project.id, {
        status: "DUPLICATE",
        limit: 50,
      });
      expect(duplicates.items.map((c) => c.id)).toEqual([dupe.id]);

      // detail includes source records (batch + source) + identifiers + duplicate labels
      const detail = await citations.getCitation(ctx(owner.id), project.id, dupe.id);
      expect(detail.sourceRecords.length).toBeGreaterThan(0);
      expect(detail.sourceRecords[0]!.batch.source.id).toBe(source.id);
      expect(detail.duplicateOf).toMatchObject({ id: all.items[1]!.id });
      const canonical = await citations.getCitation(ctx(owner.id), project.id, all.items[1]!.id);
      expect(canonical.duplicates.map((d) => d.id)).toContain(dupe.id);
    });

    it("IDOR: a citation from project B via project A's path → 404", async () => {
      const { owner, org, project: projectA } = await createProjectWithTeam();
      const projectB = await createTestProject(org.id, owner.id);
      const citationB = await createTestCitation(projectB.id);

      // owner is a member of BOTH projects — scoping alone must produce the 404
      await expectAppError(
        citations.getCitation(ctx(owner.id), projectA.id, citationB.id),
        "NOT_FOUND",
      );
      // and batch loads are scoped the same way
      await expectAppError(imports.getBatch(ctx(owner.id), projectA.id, "nonexistent"), "NOT_FOUND");
    });

    it("non-members and org-removed members cannot read citations", async () => {
      const { owner, org, project } = await createProjectWithTeam();
      await createTestCitation(project.id);

      const stranger = await createTestUser();
      await expectAppError(
        citations.listCitations(ctx(stranger.id), project.id, { status: "ACTIVE", limit: 50 }),
        "FORBIDDEN",
      );

      // R10: ACTIVE project member whose org membership was removed loses access
      const exMember = await createTestUser();
      await addOrgMember(org.id, exMember.id);
      await addProjectMember(project.id, exMember.id, ["REVIEWER"]);
      await prisma.organizationMember.update({
        where: { orgId_userId: { orgId: org.id, userId: exMember.id } },
        data: { status: "REMOVED" },
      });
      await expectAppError(
        citations.listCitations(ctx(exMember.id), project.id, { status: "ACTIVE", limit: 50 }),
        "FORBIDDEN",
      );
      expect(owner.id).toBeTruthy();
    });
  });
});
