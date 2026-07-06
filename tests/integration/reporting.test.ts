// Reporting domain integration tests: R1 blind-filtered audit query, PRISMA counts +
// snapshots, exports (R1 gating + CSV serialization), and the project dashboard.
// Run against its own database: srb_test_reporting (see agent scope notes).
import { beforeAll, describe, expect, it } from "vitest";
import type { Citation, Project, ScreeningStage, Study, User } from "@prisma/client";
import { prisma } from "@/server/db";
import { AppError } from "@/server/errors";
import { listAuditEvents } from "@/server/services/audit-query";
import {
  computePrismaCounts,
  createPrismaSnapshot,
  getPrismaSnapshot,
  listPrismaSnapshots,
} from "@/server/services/prisma-report";
import { createExport, downloadExport, listExports } from "@/server/services/exports";
import { toCsv } from "@/server/services/exports/serializers";
import { getDashboard } from "@/server/services/dashboard";
import { resetDb } from "../db-utils";
import {
  addOrgMember,
  addProjectMember,
  createTestCitation,
  createTestOrg,
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

interface Fixture {
  owner: User;
  reviewer1: User;
  reviewer2: User;
  adjudicator: User;
  statistician: User;
  outsider: User;
  project: Project;
  citations: Citation[]; // c[0]..c[11]; c[10], c[11] are DUPLICATE
  ta: ScreeningStage;
  ft: ScreeningStage;
  study: Study;
  r1DecisionEventEntityId: string;
  r2DecisionEventEntityId: string;
}

// Hand-built fixture (direct prisma writes — services under test are the reporting ones):
//   12 committed source records (PubMed 8, Embase 4) → 12 citations, 2 later DUPLICATE.
//   TA: results INCLUDE c0,c1,c2 + EXCLUDE c3..c7; open conflict pair on c8; c9 untouched.
//   Full text: c1 has file+link (retrieved); c2 has latest attempt NOT_RETRIEVED, no link.
//   FT: c0 INCLUDE (consensus) → Study (+report link, inQuantitativeSynthesis);
//       c1 EXCLUDE via ADJUDICATION (adjudication reason "Wrong population" must win over the
//       decision-level reason); c2 EXCLUDE via consensus (decision reason "No outcome data").
async function buildFixture(): Promise<Fixture> {
  const owner = await createTestUser({ name: "Olive Owner" });
  const reviewer1 = await createTestUser({ name: "Rita ReviewerOne" });
  const reviewer2 = await createTestUser({ name: "Remy ReviewerTwo" });
  const adjudicator = await createTestUser({ name: "Ada Adjudicator" });
  const statistician = await createTestUser({ name: "Stan Statistician" });
  const outsider = await createTestUser({ name: "Oscar Outsider" });
  const org = await createTestOrg(owner.id);
  for (const u of [reviewer1, reviewer2, adjudicator, statistician, outsider]) {
    await addOrgMember(org.id, u.id);
  }
  const project = await createTestProject(org.id, owner.id);
  await addProjectMember(project.id, reviewer1.id, ["REVIEWER"]);
  await addProjectMember(project.id, reviewer2.id, ["REVIEWER"]);
  await addProjectMember(project.id, adjudicator.id, ["ADJUDICATOR"]);
  await addProjectMember(project.id, statistician.id, ["STATISTICIAN"]);

  // --- imports: two sources, one committed batch each, 12 linked source records -------------
  const pubmed = await prisma.importSource.create({
    data: { projectId: project.id, name: "PubMed" },
  });
  const embase = await prisma.importSource.create({
    data: { projectId: project.id, name: "Embase" },
  });
  const batchPubmed = await prisma.importBatch.create({
    data: {
      projectId: project.id,
      sourceId: pubmed.id,
      filename: "pubmed.ris",
      format: "RIS",
      status: "COMMITTED",
      totalRecords: 8,
      parsedRecords: 8,
      committedAt: new Date(),
      createdById: owner.id,
    },
  });
  const batchEmbase = await prisma.importBatch.create({
    data: {
      projectId: project.id,
      sourceId: embase.id,
      filename: "embase.ris",
      format: "RIS",
      status: "COMMITTED",
      totalRecords: 4,
      parsedRecords: 4,
      committedAt: new Date(),
      createdById: owner.id,
    },
  });

  const citations: Citation[] = [];
  for (let i = 0; i < 12; i++) {
    citations.push(
      await createTestCitation(project.id, { title: `${uniq("Cite")} number ${i}` }),
    );
  }
  for (let i = 0; i < 12; i++) {
    await prisma.citationSourceRecord.create({
      data: {
        batchId: i < 8 ? batchPubmed.id : batchEmbase.id,
        citationId: citations[i]!.id,
        rowNumber: i + 1,
        rawRecord: `raw record ${i}`,
      },
    });
  }
  // c10, c11 merged as duplicates.
  await prisma.citation.update({
    where: { id: citations[10]!.id },
    data: { status: "DUPLICATE", duplicateOfId: citations[0]!.id },
  });
  await prisma.citation.update({
    where: { id: citations[11]!.id },
    data: { status: "DUPLICATE", duplicateOfId: citations[1]!.id },
  });

  // --- stages + exclusion reasons ------------------------------------------------------------
  const ta = await prisma.screeningStage.create({
    data: { projectId: project.id, type: "TITLE_ABSTRACT" },
  });
  const ft = await prisma.screeningStage.create({
    data: { projectId: project.id, type: "FULL_TEXT" },
  });
  const reasonPopulation = await prisma.exclusionReason.create({
    data: { projectId: project.id, label: "Wrong population", stage: "BOTH" },
  });
  const reasonOutcome = await prisma.exclusionReason.create({
    data: { projectId: project.id, label: "No outcome data", stage: "FULL_TEXT" },
  });

  // --- TA assignments (dashboard "assigned") + decisions --------------------------------------
  for (const reviewerId of [reviewer1.id, reviewer2.id]) {
    await prisma.screeningAssignment.create({
      data: { stageId: ta.id, citationId: citations[8]!.id, reviewerId },
    });
  }
  const mkDecision = (
    stageId: string,
    citationId: string,
    reviewerId: string,
    decision: "INCLUDE" | "EXCLUDE",
    exclusionReasonId?: string,
  ) =>
    prisma.screeningDecision.create({
      data: { stageId, citationId, reviewerId, decision, exclusionReasonId },
    });

  // c0: unanimous INCLUDE; c3: unanimous EXCLUDE; c8: open conflict pair.
  await mkDecision(ta.id, citations[0]!.id, reviewer1.id, "INCLUDE");
  await mkDecision(ta.id, citations[0]!.id, reviewer2.id, "INCLUDE");
  await mkDecision(ta.id, citations[3]!.id, reviewer1.id, "EXCLUDE");
  await mkDecision(ta.id, citations[3]!.id, reviewer2.id, "EXCLUDE");
  const r1ConflictDecision = await mkDecision(ta.id, citations[8]!.id, reviewer1.id, "INCLUDE");
  const r2ConflictDecision = await mkDecision(ta.id, citations[8]!.id, reviewer2.id, "EXCLUDE");
  await prisma.screeningConflict.create({
    data: { stageId: ta.id, citationId: citations[8]!.id, status: "OPEN" },
  });

  // --- TA stage results: 3 INCLUDE (c0..c2), 5 EXCLUDE (c3..c7) -------------------------------
  for (const i of [0, 1, 2]) {
    await prisma.citationStageResult.create({
      data: {
        stageId: ta.id,
        citationId: citations[i]!.id,
        outcome: "INCLUDE",
        resolvedVia: "CONSENSUS",
      },
    });
  }
  for (const i of [3, 4, 5, 6, 7]) {
    await prisma.citationStageResult.create({
      data: {
        stageId: ta.id,
        citationId: citations[i]!.id,
        outcome: "EXCLUDE",
        resolvedVia: "CONSENSUS",
      },
    });
  }

  // --- full-text retrieval: c1 retrieved (file+link); c2 latest attempt NOT_RETRIEVED --------
  const file = await prisma.fullTextFile.create({
    data: {
      projectId: project.id,
      storageKey: uniq("storage"),
      filename: "paper.pdf",
      contentType: "application/pdf",
      sizeBytes: 12345,
      sha256: uniq("sha"),
      uploadedById: owner.id,
    },
  });
  await prisma.citationFullTextLink.create({
    data: { citationId: citations[1]!.id, fileId: file.id, label: "main paper" },
  });
  await prisma.fullTextRetrievalAttempt.create({
    data: {
      citationId: citations[2]!.id,
      method: "publisher site",
      outcome: "PENDING",
      recordedById: owner.id,
      attemptedAt: new Date("2026-06-01T10:00:00.000Z"),
    },
  });
  await prisma.fullTextRetrievalAttempt.create({
    data: {
      citationId: citations[2]!.id,
      method: "author email",
      outcome: "NOT_RETRIEVED",
      recordedById: owner.id,
      attemptedAt: new Date("2026-06-15T10:00:00.000Z"),
    },
  });

  // --- FT: c0 INCLUDE → study; c1 EXCLUDE via ADJUDICATION; c2 EXCLUDE via consensus ----------
  const study = await prisma.study.create({
    data: {
      projectId: project.id,
      label: "Smith 2020",
      inQuantitativeSynthesis: true,
      createdById: owner.id,
    },
  });
  await prisma.studyReportLink.create({
    data: { studyId: study.id, citationId: citations[0]!.id, isPrimaryReport: true },
  });
  await prisma.citationStageResult.create({
    data: {
      stageId: ft.id,
      citationId: citations[0]!.id,
      outcome: "INCLUDE",
      resolvedVia: "CONSENSUS",
    },
  });

  // c1: reviewers split; adjudicated EXCLUDE with reason "Wrong population". The reviewer's
  // decision-level reason ("No outcome data") must NOT win for an ADJUDICATION result.
  await mkDecision(ft.id, citations[1]!.id, reviewer1.id, "INCLUDE");
  await mkDecision(ft.id, citations[1]!.id, reviewer2.id, "EXCLUDE", reasonOutcome.id);
  const ftConflict = await prisma.screeningConflict.create({
    data: {
      stageId: ft.id,
      citationId: citations[1]!.id,
      status: "RESOLVED",
      resolvedAt: new Date(),
    },
  });
  await prisma.screeningAdjudication.create({
    data: {
      conflictId: ftConflict.id,
      adjudicatorId: adjudicator.id,
      finalDecision: "EXCLUDE",
      exclusionReasonId: reasonPopulation.id,
      reason: "Population does not match the protocol",
    },
  });
  await prisma.citationStageResult.create({
    data: {
      stageId: ft.id,
      citationId: citations[1]!.id,
      outcome: "EXCLUDE",
      resolvedVia: "ADJUDICATION",
    },
  });

  // c2: unanimous FT EXCLUDE with "No outcome data" → consensus result, reason from decisions.
  await mkDecision(ft.id, citations[2]!.id, reviewer1.id, "EXCLUDE", reasonOutcome.id);
  await mkDecision(ft.id, citations[2]!.id, reviewer2.id, "EXCLUDE", reasonOutcome.id);
  await prisma.citationStageResult.create({
    data: {
      stageId: ft.id,
      citationId: citations[2]!.id,
      outcome: "EXCLUDE",
      resolvedVia: "CONSENSUS",
    },
  });

  // --- audit events: sensitive decision events per reviewer + a non-sensitive study event -----
  await prisma.auditEvent.create({
    data: {
      projectId: project.id,
      userId: reviewer1.id,
      entityType: "ScreeningDecision",
      entityId: r1ConflictDecision.id,
      action: "screening.decision.created",
      newValue: { decision: "INCLUDE" },
    },
  });
  await prisma.auditEvent.create({
    data: {
      projectId: project.id,
      userId: reviewer2.id,
      entityType: "ScreeningDecision",
      entityId: r2ConflictDecision.id,
      action: "screening.decision.created",
      newValue: { decision: "EXCLUDE" },
    },
  });
  await prisma.auditEvent.create({
    data: {
      projectId: project.id,
      userId: owner.id,
      entityType: "Study",
      entityId: study.id,
      action: "study.created",
      newValue: { label: study.label },
    },
  });

  return {
    owner,
    reviewer1,
    reviewer2,
    adjudicator,
    statistician,
    outsider,
    project,
    citations,
    ta,
    ft,
    study,
    r1DecisionEventEntityId: r1ConflictDecision.id,
    r2DecisionEventEntityId: r2ConflictDecision.id,
  };
}

let f: Fixture;

beforeAll(async () => {
  await resetDb();
  f = await buildFixture();
});

// ---------------------------------------------------------------------------
// PRISMA counts
// ---------------------------------------------------------------------------

describe("computePrismaCounts", () => {
  it("computes every PRISMA 2020 count and both breakdowns against hand-computed values", async () => {
    const report = await computePrismaCounts(f.project.id);
    const byKey = Object.fromEntries(report.counts.map((c) => [c.key, c]));

    expect(byKey["records_identified"]?.value).toBe(12);
    expect(byKey["records_identified"]?.breakdown).toEqual({ PubMed: 8, Embase: 4 });

    expect(byKey["duplicates_removed"]?.value).toBe(2);

    // c0..c7 via TA stage results, c8 via decisions only; c9 untouched; duplicates excluded.
    expect(byKey["records_screened"]?.value).toBe(9);
    expect(byKey["records_excluded_ta"]?.value).toBe(5);
    expect(byKey["reports_sought"]?.value).toBe(3);

    // Only c2: no link + latest attempt NOT_RETRIEVED (c0 has no attempts, c1 has a link).
    expect(byKey["reports_not_retrieved"]?.value).toBe(1);

    // c0 (FT result), c1 (FT decisions + result), c2 (FT decisions + result).
    expect(byKey["reports_assessed"]?.value).toBe(3);

    expect(byKey["reports_excluded"]?.value).toBe(2);
    expect(byKey["reports_excluded"]?.breakdown).toEqual({
      "Wrong population": 1, // c1: adjudication reason wins over decision-level reason
      "No outcome data": 1, // c2: first non-null decision reason
    });

    expect(byKey["studies_included"]?.value).toBe(1);
    expect(byKey["reports_included"]?.value).toBe(1);
    expect(byKey["studies_in_quantitative_synthesis"]?.value).toBe(1);

    expect(report.computedAt).toBeTruthy();
    expect(report.counts).toHaveLength(11);
  });
});

// ---------------------------------------------------------------------------
// PRISMA snapshots
// ---------------------------------------------------------------------------

describe("prisma snapshots", () => {
  it("statistician can freeze a snapshot: data + count rows + audit event in one shot", async () => {
    const snapshot = await createPrismaSnapshot(ctx(f.statistician.id), f.project.id, {
      label: "Pre-submission freeze",
    });
    expect(snapshot.label).toBe("Pre-submission freeze");
    expect(snapshot.counts).toHaveLength(11);
    const identified = snapshot.counts.find((c) => c.key === "records_identified");
    expect(identified?.value).toBe(12);
    expect(identified?.breakdown).toEqual({ PubMed: 8, Embase: 4 });

    const event = await prisma.auditEvent.findFirstOrThrow({
      where: {
        entityType: "PrismaSnapshot",
        entityId: snapshot.id,
        action: "prisma.snapshot.created",
      },
    });
    expect(event.userId).toBe(f.statistician.id);

    const listed = await listPrismaSnapshots(ctx(f.owner.id), f.project.id);
    expect(listed.map((s) => s.id)).toContain(snapshot.id);

    const detail = await getPrismaSnapshot(ctx(f.reviewer1.id), f.project.id, snapshot.id);
    expect(detail.counts).toHaveLength(11);
  });

  it("reviewer cannot snapshot; snapshot ids are tenant-scoped", async () => {
    await expectAppError(
      createPrismaSnapshot(ctx(f.reviewer1.id), f.project.id, { label: "nope" }),
      "FORBIDDEN",
    );
    // Snapshot from this project is invisible through another project's scope (R9).
    const snap = await createPrismaSnapshot(ctx(f.owner.id), f.project.id, {
      label: "scoping check",
    });
    const otherProject = await createTestProject(
      (await prisma.project.findUniqueOrThrow({ where: { id: f.project.id } })).orgId,
      f.owner.id,
    );
    await expectAppError(
      getPrismaSnapshot(ctx(f.owner.id), otherProject.id, snap.id),
      "NOT_FOUND",
    );
  });
});

// ---------------------------------------------------------------------------
// R1: blind-filtered audit query
// ---------------------------------------------------------------------------

describe("listAuditEvents (R1 blind filter)", () => {
  it("reviewer1 sees own ScreeningDecision events but NOT reviewer2's", async () => {
    const page = await listAuditEvents(ctx(f.reviewer1.id), f.project.id, {
      entityType: "ScreeningDecision",
    });
    const entityIds = page.events.map((e) => e.entityId);
    expect(entityIds).toContain(f.r1DecisionEventEntityId);
    expect(entityIds).not.toContain(f.r2DecisionEventEntityId);
  });

  it("reviewer1 still sees non-sensitive events with actor identity", async () => {
    const page = await listAuditEvents(ctx(f.reviewer1.id), f.project.id, {
      actionPrefix: "study.",
    });
    const studyEvent = page.events.find((e) => e.entityId === f.study.id);
    expect(studyEvent).toBeTruthy();
    expect(studyEvent?.actor).toEqual({ id: f.owner.id, name: f.owner.name });
  });

  it("adjudicator and owner see both reviewers' decision events", async () => {
    for (const caller of [f.adjudicator, f.owner]) {
      const page = await listAuditEvents(ctx(caller.id), f.project.id, {
        entityType: "ScreeningDecision",
      });
      const entityIds = page.events.map((e) => e.entityId);
      expect(entityIds).toContain(f.r1DecisionEventEntityId);
      expect(entityIds).toContain(f.r2DecisionEventEntityId);
    }
  });

  it("statistician (no adjudicate, no project.edit) sees no screening decision events", async () => {
    const page = await listAuditEvents(ctx(f.statistician.id), f.project.id, {
      entityType: "ScreeningDecision",
    });
    expect(page.events).toHaveLength(0);
    // ...but does see non-sensitive rows.
    const studies = await listAuditEvents(ctx(f.statistician.id), f.project.id, {
      actionPrefix: "study.",
    });
    expect(studies.events.length).toBeGreaterThan(0);
  });

  it("non-project-members are rejected", async () => {
    await expectAppError(listAuditEvents(ctx(f.outsider.id), f.project.id), "FORBIDDEN");
  });

  it("filters by userId and actionPrefix; paginates with a cursor", async () => {
    const r2Only = await listAuditEvents(ctx(f.owner.id), f.project.id, {
      userId: f.reviewer2.id,
      actionPrefix: "screening.",
    });
    expect(r2Only.events.length).toBeGreaterThan(0);
    expect(r2Only.events.every((e) => e.actor.id === f.reviewer2.id)).toBe(true);

    const page1 = await listAuditEvents(ctx(f.owner.id), f.project.id, { limit: 1 });
    expect(page1.events).toHaveLength(1);
    expect(page1.nextCursor).toBeTruthy();
    const page2 = await listAuditEvents(ctx(f.owner.id), f.project.id, {
      limit: 1,
      cursor: page1.nextCursor!,
    });
    expect(page2.events).toHaveLength(1);
    expect(page2.events[0]!.id).not.toBe(page1.events[0]!.id);
  });
});

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

describe("exports (R1 gating + serialization)", () => {
  it("statistician can create a CITATIONS export (201 semantics + audit)", async () => {
    const job = await createExport(ctx(f.statistician.id), f.project.id, {
      kind: "CITATIONS",
      format: "CSV",
    });
    expect(job.status).toBe("COMPLETED");
    expect(job.storageKey).toBeNull();
    await prisma.auditEvent.findFirstOrThrow({
      where: { entityType: "ExportJob", entityId: job.id, action: "export.created" },
    });
    const listed = await listExports(ctx(f.statistician.id), f.project.id);
    expect(listed.map((j) => j.id)).toContain(job.id);
  });

  it("statistician cannot create a SCREENING export; owner can", async () => {
    await expectAppError(
      createExport(ctx(f.statistician.id), f.project.id, { kind: "SCREENING", format: "CSV" }),
      "FORBIDDEN",
    );
    const job = await createExport(ctx(f.owner.id), f.project.id, {
      kind: "SCREENING",
      format: "CSV",
    });
    expect(job.kind).toBe("SCREENING");
  });

  it("FULL export as CSV is rejected with VALIDATION", async () => {
    await expectAppError(
      createExport(ctx(f.owner.id), f.project.id, { kind: "FULL", format: "CSV" }),
      "VALIDATION",
    );
  });

  it("download regenerates content, re-checks gating, and streams CSV with BOM", async () => {
    const job = await createExport(ctx(f.owner.id), f.project.id, {
      kind: "SCREENING",
      format: "CSV",
    });
    // R1 re-check at download time: statistician cannot fetch owner's SCREENING export.
    await expectAppError(
      downloadExport(ctx(f.statistician.id), f.project.id, job.id),
      "FORBIDDEN",
    );

    const file = await downloadExport(ctx(f.owner.id), f.project.id, job.id);
    expect(file.contentType).toBe("text/csv; charset=utf-8");
    expect(file.filename).toBe(`screening-${f.project.id}.csv`);
    expect(file.body.startsWith("\uFEFF")).toBe(true);
    const header = file.body.slice(1).split("\r\n")[0]!;
    expect(header.startsWith("recordType,")).toBe(true);
    expect(file.body).toContain("decision");
    expect(file.body).toContain("adjudication");
    expect(file.body).toContain("stage_result");
    expect(file.body).toContain("Wrong population");
  });

  it("CITATIONS download includes citation fields and joined sources", async () => {
    const job = await createExport(ctx(f.statistician.id), f.project.id, {
      kind: "CITATIONS",
      format: "CSV",
    });
    const file = await downloadExport(ctx(f.statistician.id), f.project.id, job.id);
    expect(file.body).toContain(f.citations[0]!.title);
    expect(file.body).toContain("PubMed");
    expect(file.body).toContain("Embase");
    expect(file.body).toContain("DUPLICATE");
  });

  it("FULL JSON export bundles every section", async () => {
    const job = await createExport(ctx(f.owner.id), f.project.id, {
      kind: "FULL",
      format: "JSON",
    });
    const file = await downloadExport(ctx(f.owner.id), f.project.id, job.id);
    expect(file.contentType).toBe("application/json");
    const payload = JSON.parse(file.body);
    expect(payload.project.id).toBe(f.project.id);
    expect(payload.citations).toHaveLength(12);
    expect(payload.screening.decisions.length).toBeGreaterThan(0);
    expect(payload.prisma.counts).toHaveLength(11);
    expect(Array.isArray(payload.audit)).toBe(true);
  });

  it("export jobs are tenant-scoped on download", async () => {
    const job = await createExport(ctx(f.owner.id), f.project.id, {
      kind: "CITATIONS",
      format: "JSON",
    });
    const org = await prisma.project.findUniqueOrThrow({ where: { id: f.project.id } });
    const otherProject = await createTestProject(org.orgId, f.owner.id);
    await expectAppError(downloadExport(ctx(f.owner.id), otherProject.id, job.id), "NOT_FOUND");
  });
});

// ---------------------------------------------------------------------------
// CSV serializer quoting (unit-style asserts; full suite colocated with the module)
// ---------------------------------------------------------------------------

describe("toCsv quoting", () => {
  it("quotes commas, doubles quotes, preserves newlines and unicode", () => {
    const csv = toCsv([
      { a: "x,y", b: 'say "hi"', c: "l1\nl2", d: "Müller 中文" },
    ]);
    expect(csv).toBe('a,b,c,d\r\n"x,y","say ""hi""","l1\nl2",Müller 中文\r\n');
  });
});

// ---------------------------------------------------------------------------
// Dashboard
// ---------------------------------------------------------------------------

describe("dashboard", () => {
  it("aggregates stats matching the hand-computed fixture", async () => {
    const dash = await getDashboard(ctx(f.owner.id), f.project.id);
    expect(dash.project).toEqual({
      id: f.project.id,
      title: f.project.title,
      reviewType: "SYSTEMATIC_REVIEW",
      status: "PLANNING",
    });
    expect(dash.stats.citations).toEqual({ total: 12, active: 10, duplicates: 2 });

    const taStats = dash.stats.screening.find((s) => s.type === "TITLE_ABSTRACT");
    expect(taStats).toEqual({
      type: "TITLE_ABSTRACT",
      assigned: 2,
      decided: 6, // c0 x2, c3 x2, c8 x2
      openConflicts: 1,
      results: { include: 3, exclude: 5 },
    });
    const ftStats = dash.stats.screening.find((s) => s.type === "FULL_TEXT");
    expect(ftStats).toEqual({
      type: "FULL_TEXT",
      assigned: 0,
      decided: 4, // c1 x2, c2 x2
      openConflicts: 0,
      results: { include: 1, exclude: 2 },
    });

    expect(dash.stats.fulltext).toEqual({ sought: 3, retrieved: 1, notRetrieved: 1 });
    expect(dash.stats.extraction).toEqual({ forms: 0, completed: 0, openConflicts: 0 });
    expect(dash.stats.rob).toEqual({ assessments: 0, completed: 0, openConflicts: 0 });
    expect(dash.stats.studies).toEqual({ total: 1, inQuantitativeSynthesis: 1 });
    expect(dash.recentActivity.length).toBeGreaterThan(0);
    expect(dash.recentActivity.length).toBeLessThanOrEqual(15);
  });

  it("recentActivity respects R1: reviewer1 never sees reviewer2's decision events", async () => {
    const dash = await getDashboard(ctx(f.reviewer1.id), f.project.id);
    const entityIds = dash.recentActivity
      .filter((e) => e.entityType === "ScreeningDecision")
      .map((e) => e.entityId);
    expect(entityIds).toContain(f.r1DecisionEventEntityId);
    expect(entityIds).not.toContain(f.r2DecisionEventEntityId);
  });

  it("non-members cannot read the dashboard", async () => {
    await expectAppError(getDashboard(ctx(f.outsider.id), f.project.id), "FORBIDDEN");
  });
});
