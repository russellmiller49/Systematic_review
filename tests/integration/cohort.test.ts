// Integration tests for the cohort (companion-report) service against real Postgres.
// Pattern mirrors tests/integration/dedup.test.ts: resetDb once, unique data per test,
// assert BOTH the domain effect AND the audit event, assert authorization failures.
import { beforeAll, describe, expect, it } from "vitest";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/server/db";
import { AppError } from "@/server/errors";
import * as cohort from "@/server/services/cohort";
import { resetDb } from "../db-utils";
import { createProjectWithTeam, uniq } from "../factories";

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

type Author = { family: string; given?: string };

let citeSeq = 0;
async function makeCitation(
  projectId: string,
  opts: {
    title?: string;
    authors?: Author[];
    year?: number | null;
    affiliations?: string[] | null;
    registryIds?: string[];
    doi?: string | null;
  } = {},
) {
  const title = opts.title ?? `${uniq("Cohort citation")} ${++citeSeq}`;
  const citation = await prisma.citation.create({
    data: {
      projectId,
      title,
      normalizedTitle: title.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim(),
      authors: (opts.authors ?? [{ family: "Smith", given: "J" }]) as unknown as Prisma.InputJsonValue,
      year: opts.year ?? 2020,
      doi: opts.doi ?? null,
      affiliations:
        opts.affiliations === undefined
          ? undefined
          : (opts.affiliations as unknown as Prisma.InputJsonValue),
    },
  });
  for (const value of opts.registryIds ?? []) {
    await prisma.citationIdentifier.create({
      data: { citationId: citation.id, type: "REGISTRY_ID", value },
    });
  }
  return citation;
}

async function ftStage(projectId: string) {
  return prisma.screeningStage.upsert({
    where: { projectId_type: { projectId, type: "FULL_TEXT" } },
    create: { projectId, type: "FULL_TEXT" },
    update: {},
  });
}

async function markFtIncluded(projectId: string, citationId: string) {
  const stage = await ftStage(projectId);
  await prisma.citationStageResult.create({
    data: { stageId: stage.id, citationId, outcome: "INCLUDE", resolvedVia: "SINGLE_REVIEWER" },
  });
}

async function linkToStudy(
  projectId: string,
  ownerId: string,
  citationId: string,
  label: string,
  primary = true,
) {
  const study = await prisma.study.create({
    data: { projectId, label, createdById: ownerId },
  });
  await prisma.studyReportLink.create({
    data: { studyId: study.id, citationId, isPrimaryReport: primary },
  });
  return study;
}

// Add an extraction form to a study so the merge case treats it as having reviewer work.
async function addExtractionForm(projectId: string, ownerId: string, studyId: string) {
  const template = await prisma.extractionTemplate.create({
    data: { projectId, name: uniq("Template"), status: "PUBLISHED", createdById: ownerId },
  });
  return prisma.extractionForm.create({
    data: { templateId: template.id, studyId, extractorId: ownerId },
  });
}

const CRINER: Author[] = [
  { family: "Criner", given: "Gerard J." },
  { family: "Sue", given: "Richard" },
  { family: "Wright", given: "Shannon" },
];
const CRINER_FOLLOWUP: Author[] = [
  { family: "Criner", given: "Gerard J." },
  { family: "Sue", given: "Richard" },
  { family: "Dransfield", given: "Mark" },
];

describe("cohort service", () => {
  beforeAll(async () => {
    await resetDb();
  });

  // --------------------------------------------------------- runCohortDetection
  it("detects a tier-1 registry pair over the FT-included population, audits the run", async () => {
    const { project, owner, reviewer1 } = await createProjectWithTeam();
    const nct = `NCT20250001`;
    const a = await makeCitation(project.id, {
      title: "Valve therapy trial primary results",
      authors: CRINER,
      registryIds: [nct],
    });
    const b = await makeCitation(project.id, {
      title: "Valve therapy trial 24-month follow-up",
      authors: CRINER_FOLLOWUP,
      registryIds: [nct],
    });
    // A third, unrelated citation NOT in the population (no FT result, no study link).
    await makeCitation(project.id, { title: "Unrelated report", registryIds: [nct] });
    await markFtIncluded(project.id, a.id);
    await markFtIncluded(project.id, b.id);

    const summary = await cohort.runCohortDetection(ctx(owner.id), project.id);
    expect(summary).toMatchObject({
      candidates: 1,
      newlySuggested: 1,
      refreshed: 0,
      removed: 0,
      populationSize: 2, // only the two FT-included citations
    });

    const candidate = await prisma.cohortCandidate.findFirstOrThrow({
      where: { projectId: project.id },
    });
    expect(candidate.method).toBe("REGISTRY_ID");
    expect(candidate.score).toBeCloseTo(0.98, 4);
    expect(candidate.status).toBe("SUGGESTED");
    expect(candidate.citationAId < candidate.citationBId).toBe(true); // aId < bId invariant
    expect([candidate.citationAId, candidate.citationBId].sort()).toEqual([a.id, b.id].sort());
    expect((candidate.signals as { registryIds: string[] }).registryIds).toEqual([nct]);

    const runEvent = await prisma.auditEvent.findFirstOrThrow({
      where: { projectId: project.id, action: "cohort.run", entityId: project.id },
    });
    expect(runEvent.userId).toBe(owner.id);
    expect(runEvent.metadata).toMatchObject({ candidates: 1, newlySuggested: 1 });

    // REVIEWER lacks project.edit
    await expectAppError(cohort.runCohortDetection(ctx(reviewer1.id), project.id), "FORBIDDEN");
  });

  it("includes study-linked citations in the population even without an FT result", async () => {
    const { project, owner } = await createProjectWithTeam();
    const nct = `NCT20250002`;
    const a = await makeCitation(project.id, { authors: CRINER, registryIds: [nct] });
    const b = await makeCitation(project.id, { authors: CRINER_FOLLOWUP, registryIds: [nct] });
    await linkToStudy(project.id, owner.id, a.id, "Criner 2018");
    await markFtIncluded(project.id, b.id);

    const summary = await cohort.runCohortDetection(ctx(owner.id), project.id);
    expect(summary.populationSize).toBe(2);
    expect(summary.candidates).toBe(1);
  });

  it("rerun is idempotent: refreshes SUGGESTED, never resurrects decided, removes stale", async () => {
    const { project, owner } = await createProjectWithTeam();
    const nct = `NCT20250003`;
    const a = await makeCitation(project.id, { authors: CRINER, registryIds: [nct] });
    const b = await makeCitation(project.id, { authors: CRINER_FOLLOWUP, registryIds: [nct] });
    await markFtIncluded(project.id, a.id);
    await markFtIncluded(project.id, b.id);

    await cohort.runCohortDetection(ctx(owner.id), project.id);
    const candidate = await prisma.cohortCandidate.findFirstOrThrow({
      where: { projectId: project.id },
    });

    // Rerun with no change → refresh, no new rows.
    const rerun = await cohort.runCohortDetection(ctx(owner.id), project.id);
    expect(rerun).toMatchObject({ newlySuggested: 0, refreshed: 1, removed: 0 });
    expect(await prisma.cohortCandidate.count({ where: { projectId: project.id } })).toBe(1);

    // Reject, then remove the shared registry id so the pair is no longer proposed.
    await cohort.rejectCohortCandidate(ctx(owner.id), project.id, candidate.id);
    const afterReject = await cohort.runCohortDetection(ctx(owner.id), project.id);
    expect(afterReject).toMatchObject({ newlySuggested: 0, refreshed: 0, skippedDecided: 1 });
    // The decided (REJECTED) row is untouched — never resurrected or deleted as "stale".
    expect(
      (await prisma.cohortCandidate.findUniqueOrThrow({ where: { id: candidate.id } })).status,
    ).toBe("REJECTED");

    // A fresh SUGGESTED pair that stops matching is deleted on the next run.
    // Disjoint authors: the registry id is the pair's ONLY signal, so dropping it
    // makes the pair vanish (overlapping authors would just refresh it as COMPOSITE).
    const c = await makeCitation(project.id, {
      authors: [{ family: "Novak", given: "P" }],
      registryIds: [`NCT20250004`],
    });
    const d = await makeCitation(project.id, {
      authors: [{ family: "Okafor", given: "C" }],
      registryIds: [`NCT20250004`], // shared with c — the pair must tier-1 match first
    });
    await markFtIncluded(project.id, c.id);
    await markFtIncluded(project.id, d.id);
    await cohort.runCohortDetection(ctx(owner.id), project.id);
    const fresh = await prisma.cohortCandidate.findFirstOrThrow({
      where: { projectId: project.id, status: "SUGGESTED" },
    });
    // Drop d's registry id → the pair is no longer proposed.
    await prisma.citationIdentifier.deleteMany({ where: { citationId: d.id } });
    const afterDrop = await cohort.runCohortDetection(ctx(owner.id), project.id);
    expect(afterDrop.removed).toBe(1);
    expect(await prisma.cohortCandidate.findUnique({ where: { id: fresh.id } })).toBeNull();
  });

  it("lazily backfills affiliations + registry ids from preserved raw records", async () => {
    const { project, owner } = await createProjectWithTeam();
    const source = await prisma.importSource.create({
      data: { projectId: project.id, name: uniq("PubMed") },
    });
    const batch = await prisma.importBatch.create({
      data: {
        projectId: project.id,
        sourceId: source.id,
        filename: "s.nbib",
        format: "NBIB",
        status: "COMMITTED",
        createdById: owner.id,
      },
    });
    const nct = `NCT20250006`;
    const raw = `PMID- 40000001
TI  - Backfilled valve trial report.
AB  - A trial (ClinicalTrials.gov/${nct}).
AD  - Temple University, Philadelphia, PA, USA.
FAU - Criner, Gerard J
JT  - Am J Respir Crit Care Med
`;
    // Citation imported before capture existed: affiliations null, no REGISTRY_ID rows.
    const c = await makeCitation(project.id, { authors: CRINER, affiliations: null });
    await prisma.citationSourceRecord.create({
      data: { batchId: batch.id, citationId: c.id, rowNumber: 1, rawRecord: raw },
    });
    await markFtIncluded(project.id, c.id);
    // A partner already carrying the registry id so the run yields a pair.
    const partner = await makeCitation(project.id, {
      authors: CRINER_FOLLOWUP,
      registryIds: [nct],
    });
    await markFtIncluded(project.id, partner.id);

    const summary = await cohort.runCohortDetection(ctx(owner.id), project.id);
    expect(summary.backfilled).toBe(1);
    expect(summary.candidates).toBe(1);

    const reloaded = await prisma.citation.findUniqueOrThrow({ where: { id: c.id } });
    expect(reloaded.affiliations).toEqual(["Temple University, Philadelphia, PA, USA."]);
    const ids = await prisma.citationIdentifier.findMany({
      where: { citationId: c.id, type: "REGISTRY_ID" },
    });
    expect(ids.map((i) => i.value)).toEqual([nct]);
  });

  // -------------------------------------------------------- listCohortCandidates
  it("lists candidates with study links; project.view holders can read", async () => {
    const { project, owner, reviewer1 } = await createProjectWithTeam();
    const nct = `NCT20250007`;
    const a = await makeCitation(project.id, { authors: CRINER, registryIds: [nct] });
    const b = await makeCitation(project.id, { authors: CRINER_FOLLOWUP, registryIds: [nct] });
    const study = await linkToStudy(project.id, owner.id, a.id, "Criner 2018");
    await markFtIncluded(project.id, b.id);
    await cohort.runCohortDetection(ctx(owner.id), project.id);

    // REVIEWER (project.view) can list.
    const listed = await cohort.listCohortCandidates(ctx(reviewer1.id), project.id);
    expect(listed).toHaveLength(1);
    const cand = listed[0]!;
    expect(cand.citationA.title).toBeTruthy();
    expect(cand.citationB.title).toBeTruthy();
    const withStudy = [cand.citationA, cand.citationB].find((c) => c.id === a.id)!;
    expect(withStudy.studies).toEqual([{ id: study.id, label: "Criner 2018" }]);

    // status filter
    expect(await cohort.listCohortCandidates(ctx(owner.id), project.id, { status: "LINKED" })).toHaveLength(0);

    const outsider = await prisma.user.create({
      data: { email: `${uniq("out")}@test.local`, name: "Outsider", passwordHash: "x" },
    });
    await expectAppError(cohort.listCohortCandidates(ctx(outsider.id), project.id), "FORBIDDEN");
  });

  // -------------------------------------------------------- linkCohortCandidate
  it("Case 1: links the unlinked report into the other side's study", async () => {
    const { project, owner, reviewer1 } = await createProjectWithTeam();
    const nct = `NCT20250008`;
    const linked = await makeCitation(project.id, { authors: CRINER, registryIds: [nct] });
    const loose = await makeCitation(project.id, { authors: CRINER_FOLLOWUP, registryIds: [nct] });
    const study = await linkToStudy(project.id, owner.id, linked.id, "Criner 2018");
    await markFtIncluded(project.id, loose.id);
    await cohort.runCohortDetection(ctx(owner.id), project.id);
    const candidate = await prisma.cohortCandidate.findFirstOrThrow({ where: { projectId: project.id } });

    // REVIEWER lacks project.edit
    await expectAppError(
      cohort.linkCohortCandidate(ctx(reviewer1.id), project.id, candidate.id),
      "FORBIDDEN",
    );

    const result = await cohort.linkCohortCandidate(ctx(owner.id), project.id, candidate.id);
    expect(result.case).toBe("LINKED_INTO_EXISTING");
    expect(result.studyId).toBe(study.id);

    const links = await prisma.studyReportLink.findMany({ where: { studyId: study.id } });
    expect(links.map((l) => l.citationId).sort()).toEqual([linked.id, loose.id].sort());
    const looseLink = links.find((l) => l.citationId === loose.id)!;
    expect(looseLink.isPrimaryReport).toBe(false);

    const decided = await prisma.cohortCandidate.findUniqueOrThrow({ where: { id: candidate.id } });
    expect(decided.status).toBe("LINKED");
    expect(decided.decidedById).toBe(owner.id);

    const event = await prisma.auditEvent.findFirstOrThrow({
      where: { entityType: "CohortCandidate", entityId: candidate.id, action: "cohort.linked" },
    });
    expect(event.metadata).toMatchObject({ case: "LINKED_INTO_EXISTING", studyId: study.id });

    // Re-linking a decided candidate → 422
    await expectAppError(
      cohort.linkCohortCandidate(ctx(owner.id), project.id, candidate.id),
      "INVALID_STATE",
    );
  });

  it("Case 2: creates a study labeled from the earlier citation and links both reports", async () => {
    const { project, owner } = await createProjectWithTeam();
    const nct = `NCT20250009`;
    const earlier = await makeCitation(project.id, {
      authors: CRINER,
      year: 2018,
      registryIds: [nct],
    });
    const later = await makeCitation(project.id, {
      authors: CRINER_FOLLOWUP,
      year: 2019,
      registryIds: [nct],
    });
    await markFtIncluded(project.id, earlier.id);
    await markFtIncluded(project.id, later.id);
    await cohort.runCohortDetection(ctx(owner.id), project.id);
    const candidate = await prisma.cohortCandidate.findFirstOrThrow({ where: { projectId: project.id } });

    const result = await cohort.linkCohortCandidate(ctx(owner.id), project.id, candidate.id);
    expect(result.case).toBe("CREATED_STUDY");

    const study = await prisma.study.findUniqueOrThrow({
      where: { id: result.studyId },
      include: { reportLinks: true },
    });
    expect(study.label).toBe("Criner 2018"); // labeled from the earlier-year citation
    expect(study.reportLinks).toHaveLength(2);
    const primary = study.reportLinks.find((l) => l.isPrimaryReport)!;
    expect(primary.citationId).toBe(earlier.id);

    await prisma.auditEvent.findFirstOrThrow({
      where: { entityType: "Study", entityId: study.id, action: "study.created" },
    });
    const linkEvent = await prisma.auditEvent.findFirstOrThrow({
      where: { entityType: "CohortCandidate", entityId: candidate.id, action: "cohort.linked" },
    });
    expect(linkEvent.metadata).toMatchObject({ case: "CREATED_STUDY", studyId: study.id });
  });

  it("Case 3: merges the source study into the target when it has no reviewer work", async () => {
    const { project, owner } = await createProjectWithTeam();
    const nct = `NCT20250010`;
    const a = await makeCitation(project.id, { authors: CRINER, registryIds: [nct] });
    const b = await makeCitation(project.id, { authors: CRINER_FOLLOWUP, registryIds: [nct] });
    const studyA = await linkToStudy(project.id, owner.id, a.id, "Criner 2018");
    const studyB = await linkToStudy(project.id, owner.id, b.id, "Criner 2019");
    await cohort.runCohortDetection(ctx(owner.id), project.id);
    const candidate = await prisma.cohortCandidate.findFirstOrThrow({ where: { projectId: project.id } });

    const result = await cohort.linkCohortCandidate(ctx(owner.id), project.id, candidate.id);
    expect(result.case).toBe("MERGED_STUDIES");

    // Exactly one study survives; both reports hang off it.
    const survivingId = result.studyId;
    const goneId = survivingId === studyA.id ? studyB.id : studyA.id;
    expect(await prisma.study.findUnique({ where: { id: goneId } })).toBeNull();
    const links = await prisma.studyReportLink.findMany({ where: { studyId: survivingId } });
    expect(links.map((l) => l.citationId).sort()).toEqual([a.id, b.id].sort());

    const mergeEvent = await prisma.auditEvent.findFirstOrThrow({
      where: { entityType: "Study", entityId: goneId, action: "study.merged" },
    });
    expect(mergeEvent.metadata).toMatchObject({ from: goneId, to: survivingId });
  });

  it("Case 3 blocked: merge refused when either study carries extraction work", async () => {
    const { project, owner } = await createProjectWithTeam();
    const nct = `NCT20250011`;
    const a = await makeCitation(project.id, { authors: CRINER, registryIds: [nct] });
    const b = await makeCitation(project.id, { authors: CRINER_FOLLOWUP, registryIds: [nct] });
    const studyA = await linkToStudy(project.id, owner.id, a.id, "Criner 2018");
    const studyB = await linkToStudy(project.id, owner.id, b.id, "Criner 2019");
    // Extraction work on BOTH studies → the source (whichever it is) is protected.
    await addExtractionForm(project.id, owner.id, studyA.id);
    await addExtractionForm(project.id, owner.id, studyB.id);
    await cohort.runCohortDetection(ctx(owner.id), project.id);
    const candidate = await prisma.cohortCandidate.findFirstOrThrow({ where: { projectId: project.id } });

    await expectAppError(
      cohort.linkCohortCandidate(ctx(owner.id), project.id, candidate.id),
      "INVALID_STATE",
    );
    // Nothing changed: both studies still exist, candidate still SUGGESTED.
    expect(await prisma.study.count({ where: { projectId: project.id } })).toBe(2);
    expect(
      (await prisma.cohortCandidate.findUniqueOrThrow({ where: { id: candidate.id } })).status,
    ).toBe("SUGGESTED");
  });

  // ------------------------------------------------------ rejectCohortCandidate
  it("rejectCandidate marks REJECTED, audits; double-reject 422; project.edit required", async () => {
    const { project, owner, reviewer1 } = await createProjectWithTeam();
    const nct = `NCT20250012`;
    const a = await makeCitation(project.id, { authors: CRINER, registryIds: [nct] });
    const b = await makeCitation(project.id, { authors: CRINER_FOLLOWUP, registryIds: [nct] });
    await markFtIncluded(project.id, a.id);
    await markFtIncluded(project.id, b.id);
    await cohort.runCohortDetection(ctx(owner.id), project.id);
    const candidate = await prisma.cohortCandidate.findFirstOrThrow({ where: { projectId: project.id } });

    await expectAppError(
      cohort.rejectCohortCandidate(ctx(reviewer1.id), project.id, candidate.id),
      "FORBIDDEN",
    );

    const result = await cohort.rejectCohortCandidate(ctx(owner.id), project.id, candidate.id);
    expect(result.candidate.status).toBe("REJECTED");
    expect(result.candidate.decidedById).toBe(owner.id);

    const event = await prisma.auditEvent.findFirstOrThrow({
      where: { entityType: "CohortCandidate", entityId: candidate.id, action: "cohort.rejected" },
    });
    expect(event.newValue).toMatchObject({ status: "REJECTED" });

    await expectAppError(
      cohort.rejectCohortCandidate(ctx(owner.id), project.id, candidate.id),
      "INVALID_STATE",
    );
  });

  // ------------------------------------------------------------------ R9 tenancy
  it("R9: a candidate from another project via this project's path → 404", async () => {
    const projectA = await createProjectWithTeam();
    const projectB = await createProjectWithTeam();
    const nct = `NCT20250013`;
    const a = await makeCitation(projectA.project.id, { authors: CRINER, registryIds: [nct] });
    const b = await makeCitation(projectA.project.id, { authors: CRINER_FOLLOWUP, registryIds: [nct] });
    await markFtIncluded(projectA.project.id, a.id);
    await markFtIncluded(projectA.project.id, b.id);
    await cohort.runCohortDetection(ctx(projectA.owner.id), projectA.project.id);
    const candidate = await prisma.cohortCandidate.findFirstOrThrow({
      where: { projectId: projectA.project.id },
    });

    await expectAppError(
      cohort.linkCohortCandidate(ctx(projectB.owner.id), projectB.project.id, candidate.id),
      "NOT_FOUND",
    );
    await expectAppError(
      cohort.rejectCohortCandidate(ctx(projectB.owner.id), projectB.project.id, candidate.id),
      "NOT_FOUND",
    );
  });
});
