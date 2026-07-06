// Integration tests for the dedup service against real Postgres (own db: srb_test_dedup).
// Pattern per tests/integration/orgs.test.ts: resetDb once, unique data per test, assert
// BOTH the domain effect AND the audit event, assert authorization failures.
import { beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/server/db";
import { AppError } from "@/server/errors";
import * as dedup from "@/server/services/dedup";
import { resetDb } from "../db-utils";
import { createProjectWithTeam, createTestCitation, uniq } from "../factories";

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

// ---------------------------------------------------------------------------
// Local precondition helpers (factories.ts is shared/frozen — do not edit it).
// ---------------------------------------------------------------------------

async function createImportBatch(projectId: string, createdById: string) {
  const source = await prisma.importSource.create({
    data: { projectId, name: uniq("PubMed") },
  });
  return prisma.importBatch.create({
    data: {
      projectId,
      sourceId: source.id,
      filename: "test.ris",
      format: "RIS",
      status: "COMMITTED",
      createdById,
    },
  });
}

let rowSeq = 0;
async function createCitationWithSource(
  projectId: string,
  batchId: string,
  overrides: Parameters<typeof createTestCitation>[1] = {},
) {
  const citation = await createTestCitation(projectId, overrides);
  await prisma.citationSourceRecord.create({
    data: {
      batchId,
      citationId: citation.id,
      rowNumber: ++rowSeq,
      rawRecord: `RAW ${citation.title}`,
    },
  });
  return citation;
}

async function createStage(projectId: string) {
  return prisma.screeningStage.create({
    data: { projectId, type: "TITLE_ABSTRACT" },
  });
}

// One exact-DOI duplicate pair, detection already run — the standard merge fixture.
async function seedExactPair() {
  const team = await createProjectWithTeam();
  const batch = await createImportBatch(team.project.id, team.owner.id);
  const doi = `10.1234/${uniq("trial")}`;
  const canonical = await createCitationWithSource(team.project.id, batch.id, {
    title: "Tiotropium versus placebo for COPD exacerbations a randomized controlled trial",
    doi,
    year: 2019,
  });
  const duplicate = await createCitationWithSource(team.project.id, batch.id, {
    title: "Tiotropium vs placebo for chronic obstructive pulmonary disease exacerbations",
    doi: `https://doi.org/${doi.toUpperCase()}`, // engine normalizes resolver prefix + case
    year: 2019,
  });
  await dedup.runDetection(ctx(team.owner.id), team.project.id);
  const candidate = await prisma.deduplicationCandidate.findFirstOrThrow({
    where: { projectId: team.project.id },
  });
  return { ...team, batch, canonical, duplicate, candidate, groupId: candidate.groupId! };
}

describe("dedup service", () => {
  beforeAll(async () => {
    await resetDb();
  });

  // ------------------------------------------------------------- runDetection
  it("detects exact + fuzzy pairs, builds groups with evidence, audits the run", async () => {
    const { project, owner, reviewer1 } = await createProjectWithTeam();
    const batch = await createImportBatch(project.id, owner.id);
    const doi = `10.1234/${uniq("copd")}`;

    const c1 = await createCitationWithSource(project.id, batch.id, {
      title: "Tiotropium versus placebo for COPD exacerbations a randomized controlled trial",
      doi,
      year: 2019,
    });
    const c2 = await createCitationWithSource(project.id, batch.id, {
      title: "Completely different secondary analysis of the tiotropium exacerbation cohort",
      doi,
      year: 2020,
    });
    const c3 = await createCitationWithSource(project.id, batch.id, {
      title:
        "Effects of azithromycin on exacerbation frequency in severe asthma: a randomized controlled trial",
      year: 2021,
    });
    const c4 = await createCitationWithSource(project.id, batch.id, {
      title:
        "Effects of azithromycin on exacerbation frequency in severe asthma - a randomised controlled trial.",
      year: 2021,
    });
    const c5 = await createCitationWithSource(project.id, batch.id, {
      title: "Prevalence of vitamin D deficiency among nursing home residents in northern climates",
      year: 2021,
    });

    const summary = await dedup.runDetection(ctx(owner.id), project.id);
    expect(summary).toMatchObject({
      citationsScanned: 5,
      pairsDetected: 2,
      candidatesCreated: 2,
      candidatesRefreshed: 0,
      groupsOpen: 2,
    });

    const candidates = await prisma.deduplicationCandidate.findMany({
      where: { projectId: project.id },
    });
    expect(candidates).toHaveLength(2);
    for (const c of candidates) {
      expect(c.citationAId < c.citationBId).toBe(true); // aId < bId invariant
      expect(c.groupId).toBeTruthy();
      expect(c.status).toBe("SUGGESTED");
    }

    const exact = candidates.find((c) => c.method === "EXACT_DOI");
    expect(exact).toBeDefined();
    expect([exact!.citationAId, exact!.citationBId].sort()).toEqual([c1.id, c2.id].sort());
    expect(exact!.score).toBe(1);
    expect(exact!.reasons).toMatchObject({ matchedOn: ["doi"] });

    const fuzzy = candidates.find((c) => c.method === "FUZZY");
    expect(fuzzy).toBeDefined();
    expect([fuzzy!.citationAId, fuzzy!.citationBId].sort()).toEqual([c3.id, c4.id].sort());
    expect(fuzzy!.score).toBeGreaterThanOrEqual(0.75);
    const reasons = fuzzy!.reasons as {
      titleSimilarity: number;
      authorOverlap: number;
      yearMatch: boolean;
      journalMatch: boolean;
    };
    expect(reasons.titleSimilarity).toBeGreaterThanOrEqual(0.82);
    expect(reasons.authorOverlap).toBe(1);
    expect(reasons.yearMatch).toBe(true);
    expect(reasons.journalMatch).toBe(true);

    // the unrelated citation is in no candidate pair
    for (const c of candidates) {
      expect([c.citationAId, c.citationBId]).not.toContain(c5.id);
    }

    // exact and fuzzy pairs land in separate groups, both OPEN
    expect(exact!.groupId).not.toBe(fuzzy!.groupId);
    const groups = await prisma.deduplicationGroup.findMany({ where: { projectId: project.id } });
    expect(groups).toHaveLength(2);
    for (const g of groups) expect(g.status).toBe("OPEN");

    const runEvent = await prisma.auditEvent.findFirstOrThrow({
      where: { projectId: project.id, action: "dedup.run", entityId: project.id },
    });
    expect(runEvent.userId).toBe(owner.id);
    expect(runEvent.metadata).toMatchObject({ candidatesCreated: 2 });

    // REVIEWER lacks dedup.manage
    await expectAppError(dedup.runDetection(ctx(reviewer1.id), project.id), "FORBIDDEN");
  });

  it("rerun is idempotent: refreshes SUGGESTED, never resurrects REJECTED", async () => {
    const { project, owner } = await createProjectWithTeam();
    const batch = await createImportBatch(project.id, owner.id);
    const doi = `10.5555/${uniq("dup")}`;
    await createCitationWithSource(project.id, batch.id, { title: "Report of trial alpha", doi });
    await createCitationWithSource(project.id, batch.id, { title: "Trial alpha second report", doi });

    await dedup.runDetection(ctx(owner.id), project.id);
    const candidate = await prisma.deduplicationCandidate.findFirstOrThrow({
      where: { projectId: project.id },
    });

    // rerun without changes → refresh, no duplicates created
    const rerun = await dedup.runDetection(ctx(owner.id), project.id);
    expect(rerun).toMatchObject({ candidatesCreated: 0, candidatesRefreshed: 1, groupsOpen: 1 });
    expect(await prisma.deduplicationCandidate.count({ where: { projectId: project.id } })).toBe(1);

    // reject, then rerun → the decided pair is skipped and the group stays RESOLVED
    await dedup.rejectCandidate(ctx(owner.id), project.id, candidate.id);
    const afterReject = await dedup.runDetection(ctx(owner.id), project.id);
    expect(afterReject).toMatchObject({
      candidatesCreated: 0,
      candidatesRefreshed: 0,
      candidatesSkippedDecided: 1,
      groupsOpen: 0,
    });
    const rejected = await prisma.deduplicationCandidate.findUniqueOrThrow({
      where: { id: candidate.id },
    });
    expect(rejected.status).toBe("REJECTED");
    const group = await prisma.deduplicationGroup.findUniqueOrThrow({
      where: { id: candidate.groupId! },
    });
    expect(group.status).toBe("RESOLVED");
  });

  // ---------------------------------------------------------------- listGroups
  it("lists OPEN groups with full citation payloads and evidence; project.view required", async () => {
    const { project, owner, reviewer1 } = await createProjectWithTeam();
    const batch = await createImportBatch(project.id, owner.id);
    const doi = `10.4321/${uniq("x")}`;
    await createCitationWithSource(project.id, batch.id, { title: "Study report A", doi });
    await createCitationWithSource(project.id, batch.id, { title: "Study report A prime", doi });
    await dedup.runDetection(ctx(owner.id), project.id);

    // any project.view holder (REVIEWER) can list
    const groups = await dedup.listGroups(ctx(reviewer1.id), project.id);
    expect(groups).toHaveLength(1);
    const [group] = groups;
    expect(group!.status).toBe("OPEN");
    expect(group!.candidates).toHaveLength(1);
    const cand = group!.candidates[0]!;
    expect(cand.citationA.title).toBeTruthy();
    expect(cand.citationB.title).toBeTruthy();
    expect(cand.citationA.doi).toBeTruthy();
    expect(cand.reasons).toMatchObject({ matchedOn: ["doi"] });

    // default filter hides RESOLVED groups; ?status=RESOLVED shows them
    await dedup.mergeGroup(ctx(owner.id), project.id, group!.id, {
      canonicalCitationId: cand.citationAId,
    });
    expect(await dedup.listGroups(ctx(owner.id), project.id)).toHaveLength(0);
    expect(
      await dedup.listGroups(ctx(owner.id), project.id, { status: "RESOLVED" }),
    ).toHaveLength(1);

    // non-member → 403
    const outsider = await prisma.user.create({
      data: { email: `${uniq("out")}@test.local`, name: "Outsider", passwordHash: "x" },
    });
    await expectAppError(dedup.listGroups(ctx(outsider.id), project.id), "FORBIDDEN");
  });

  // --------------------------------------------------------------------- merge
  it("merge: duplicate flipped, source records survive, PENDING assignment + OPEN conflict voided, audited", async () => {
    const seeded = await seedExactPair();
    const { project, owner, reviewer1, canonical, duplicate, candidate, groupId } = seeded;

    const stage = await createStage(project.id);
    const assignment = await prisma.screeningAssignment.create({
      data: { stageId: stage.id, citationId: duplicate.id, reviewerId: reviewer1.id },
    });
    const conflict = await prisma.screeningConflict.create({
      data: { stageId: stage.id, citationId: duplicate.id },
    });
    // canonical's own PENDING assignment must NOT be voided
    const canonicalAssignment = await prisma.screeningAssignment.create({
      data: { stageId: stage.id, citationId: canonical.id, reviewerId: reviewer1.id },
    });

    const result = await dedup.mergeGroup(ctx(owner.id), project.id, groupId, {
      canonicalCitationId: canonical.id,
    });
    expect(result.mergedCitationIds).toEqual([duplicate.id]);
    expect(result.voidedAssignmentIds).toEqual([assignment.id]);
    expect(result.voidedConflictIds).toEqual([conflict.id]);
    expect(result.warning).toBeNull();

    const dup = await prisma.citation.findUniqueOrThrow({ where: { id: duplicate.id } });
    expect(dup.status).toBe("DUPLICATE");
    expect(dup.duplicateOfId).toBe(canonical.id);

    // source records SURVIVE on the merged duplicate — nothing is moved or deleted
    const sourceRecords = await prisma.citationSourceRecord.findMany({
      where: { citationId: duplicate.id },
    });
    expect(sourceRecords).toHaveLength(1);

    expect(
      (await prisma.screeningAssignment.findUniqueOrThrow({ where: { id: assignment.id } })).status,
    ).toBe("VOIDED");
    expect(
      (await prisma.screeningConflict.findUniqueOrThrow({ where: { id: conflict.id } })).status,
    ).toBe("VOIDED");
    expect(
      (
        await prisma.screeningAssignment.findUniqueOrThrow({
          where: { id: canonicalAssignment.id },
        })
      ).status,
    ).toBe("PENDING");

    const decided = await prisma.deduplicationCandidate.findUniqueOrThrow({
      where: { id: candidate.id },
    });
    expect(decided.status).toBe("MERGED");
    expect(decided.decidedById).toBe(owner.id);
    expect(decided.decidedAt).not.toBeNull();

    const group = await prisma.deduplicationGroup.findUniqueOrThrow({ where: { id: groupId } });
    expect(group.status).toBe("RESOLVED");

    const mergeEvent = await prisma.auditEvent.findFirstOrThrow({
      where: { entityType: "Citation", entityId: duplicate.id, action: "dedup.merged" },
    });
    expect(mergeEvent.userId).toBe(owner.id);
    expect(mergeEvent.previousValue).toMatchObject({ status: "ACTIVE" });
    expect(mergeEvent.newValue).toMatchObject({
      status: "DUPLICATE",
      duplicateOfId: canonical.id,
    });
    expect(mergeEvent.metadata).toMatchObject({
      groupId,
      voidedAssignmentIds: [assignment.id],
      voidedConflictIds: [conflict.id],
    });
  });

  it("merge warns when BOTH canonical and a duplicate already carry screening decisions", async () => {
    const { project, owner, reviewer1, reviewer2, canonical, duplicate, groupId } =
      await seedExactPair();
    const stage = await createStage(project.id);
    await prisma.screeningDecision.create({
      data: {
        stageId: stage.id,
        citationId: canonical.id,
        reviewerId: reviewer1.id,
        decision: "INCLUDE",
      },
    });
    await prisma.screeningDecision.create({
      data: {
        stageId: stage.id,
        citationId: duplicate.id,
        reviewerId: reviewer2.id,
        decision: "EXCLUDE",
      },
    });

    const result = await dedup.mergeGroup(ctx(owner.id), project.id, groupId, {
      canonicalCitationId: canonical.id,
    });
    expect(result.warning).toMatchObject({
      code: "SCREENING_DECISIONS_ON_BOTH",
      canonicalCitationId: canonical.id,
      duplicateCitationIdsWithDecisions: [duplicate.id],
    });
    // the duplicate's decision is kept immutably for the record
    expect(
      await prisma.screeningDecision.count({ where: { citationId: duplicate.id } }),
    ).toBe(1);
  });

  it("merge validates canonical membership, tenancy, and permission", async () => {
    const { project, owner, reviewer1, groupId } = await seedExactPair();
    const outsiderCitation = await createTestCitation(project.id, {
      title: "Unrelated citation not in the group",
    });

    // canonical not a member of the group → 422
    await expectAppError(
      dedup.mergeGroup(ctx(owner.id), project.id, groupId, {
        canonicalCitationId: outsiderCitation.id,
      }),
      "INVALID_STATE",
    );

    // group from another project → 404 (R9 tenancy)
    const other = await seedExactPair();
    await expectAppError(
      dedup.mergeGroup(ctx(other.owner.id), other.project.id, groupId, {
        canonicalCitationId: other.canonical.id,
      }),
      "NOT_FOUND",
    );

    // REVIEWER lacks dedup.manage → 403
    const { canonical } = await seedExactPair();
    await expectAppError(
      dedup.mergeGroup(ctx(reviewer1.id), project.id, groupId, {
        canonicalCitationId: canonical.id,
      }),
      "FORBIDDEN",
    );
  });

  // ---------------------------------------------------------------------- undo
  it("undoMerge restores the citation, its voided assignment/conflict, candidates, and group", async () => {
    const { project, owner, reviewer1, canonical, duplicate, candidate, groupId } =
      await seedExactPair();
    const stage = await createStage(project.id);
    const assignment = await prisma.screeningAssignment.create({
      data: { stageId: stage.id, citationId: duplicate.id, reviewerId: reviewer1.id },
    });
    const conflict = await prisma.screeningConflict.create({
      data: { stageId: stage.id, citationId: duplicate.id },
    });
    await dedup.mergeGroup(ctx(owner.id), project.id, groupId, {
      canonicalCitationId: canonical.id,
    });

    const result = await dedup.undoMerge(ctx(owner.id), project.id, duplicate.id);
    expect(result.restoredAssignmentIds).toEqual([assignment.id]);
    expect(result.restoredConflictIds).toEqual([conflict.id]);
    expect(result.groupId).toBe(groupId);

    const restored = await prisma.citation.findUniqueOrThrow({ where: { id: duplicate.id } });
    expect(restored.status).toBe("ACTIVE");
    expect(restored.duplicateOfId).toBeNull();

    expect(
      (await prisma.screeningAssignment.findUniqueOrThrow({ where: { id: assignment.id } })).status,
    ).toBe("PENDING");
    expect(
      (await prisma.screeningConflict.findUniqueOrThrow({ where: { id: conflict.id } })).status,
    ).toBe("OPEN");

    const reopenedCandidate = await prisma.deduplicationCandidate.findUniqueOrThrow({
      where: { id: candidate.id },
    });
    expect(reopenedCandidate.status).toBe("SUGGESTED");
    expect(reopenedCandidate.decidedById).toBeNull();

    const group = await prisma.deduplicationGroup.findUniqueOrThrow({ where: { id: groupId } });
    expect(group.status).toBe("OPEN");

    const undoEvent = await prisma.auditEvent.findFirstOrThrow({
      where: { entityType: "Citation", entityId: duplicate.id, action: "dedup.merge_undone" },
    });
    expect(undoEvent.userId).toBe(owner.id);
    expect(undoEvent.previousValue).toMatchObject({
      status: "DUPLICATE",
      duplicateOfId: canonical.id,
    });
    expect(undoEvent.metadata).toMatchObject({
      groupId,
      restoredAssignmentIds: [assignment.id],
      restoredConflictIds: [conflict.id],
    });

    // undo on an ACTIVE citation → 422
    await expectAppError(
      dedup.undoMerge(ctx(owner.id), project.id, duplicate.id),
      "INVALID_STATE",
    );
  });

  // -------------------------------------------------------------------- reject
  it("rejectCandidate marks REJECTED, resolves the emptied group, audits; double-reject 422", async () => {
    const { project, owner, reviewer1, candidate, groupId } = await seedExactPair();

    // REVIEWER lacks dedup.manage
    await expectAppError(
      dedup.rejectCandidate(ctx(reviewer1.id), project.id, candidate.id),
      "FORBIDDEN",
    );

    const result = await dedup.rejectCandidate(ctx(owner.id), project.id, candidate.id);
    expect(result.candidate.status).toBe("REJECTED");
    expect(result.candidate.decidedById).toBe(owner.id);
    expect(result.groupResolved).toBe(true);

    const group = await prisma.deduplicationGroup.findUniqueOrThrow({ where: { id: groupId } });
    expect(group.status).toBe("RESOLVED");

    const event = await prisma.auditEvent.findFirstOrThrow({
      where: {
        entityType: "DeduplicationCandidate",
        entityId: candidate.id,
        action: "dedup.rejected",
      },
    });
    expect(event.userId).toBe(owner.id);
    expect(event.newValue).toMatchObject({ status: "REJECTED" });

    await expectAppError(
      dedup.rejectCandidate(ctx(owner.id), project.id, candidate.id),
      "INVALID_STATE",
    );

    // candidate from another project → 404 (R9 tenancy)
    const other = await seedExactPair();
    await expectAppError(
      dedup.rejectCandidate(ctx(other.owner.id), other.project.id, candidate.id),
      "NOT_FOUND",
    );
  });
});
