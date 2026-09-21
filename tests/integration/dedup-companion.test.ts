import { beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/server/db";
import * as dedup from "@/server/services/dedup";
import * as cohort from "@/server/services/cohort";
import * as studies from "@/server/services/studies";
import { companionGraph } from "@/server/services/studies/companions";
import * as screening from "@/server/services/screening";
import { computePrismaCounts } from "@/server/services/prisma-report";
import { resetDb } from "../db-utils";
import { createProjectWithTeam, createTestCitation } from "../factories";

// Synthetic regression: five distinct publications of a 26-patient UCL cohort, 2019–2023.
const journals = [
  "United European Gastroenterology Journal",
  "Diseases of the Esophagus",
  "Gut",
  "Endoscopy",
  "Frontline Gastroenterology",
];
async function fixture(count = 2, edges?: [number, number][]) {
  const team = await createProjectWithTeam();
  const ctx = { userId: team.owner.id };
  const citations: Awaited<ReturnType<typeof createTestCitation>>[] = [];
  for (let i = 0; i < count; i++)
    citations.push(
      await createTestCitation(team.project.id, {
        title: "Endoscopic treatment outcomes in a UCL cohort",
        journal: journals[i],
        year: i < 3 ? 2024 : 2025,
        doi: `10.1234/ucl-report-${i}`,
        abstract:
          "UCL cohort, 2019–2023: 26 patients. Treatment outcomes and follow-up results.",
      }),
    );
  const group = await prisma.deduplicationGroup.create({
    data: { projectId: team.project.id },
  });
  const pairs = [];
  const allEdges =
    edges ??
    citations.flatMap((_, i) =>
      citations.slice(i + 1).map((_, j) => [i, i + j + 1] as [number, number]),
    );
  for (const [a, b] of allEdges) {
    const [citationAId, citationBId] = [
      citations[a]!.id,
      citations[b]!.id,
    ].sort() as [string, string];
    pairs.push(
      await prisma.deduplicationCandidate.create({
        data: {
          projectId: team.project.id,
          groupId: group.id,
          citationAId,
          citationBId,
          method: "NORMALIZED_TITLE",
          score: 1,
          reasons: {},
        },
      }),
    );
  }
  const ta = await prisma.screeningStage.create({
    data: {
      projectId: team.project.id,
      type: "TITLE_ABSTRACT",
      reviewersPerCitation: 1,
    },
  });
  const ft = await prisma.screeningStage.create({
    data: {
      projectId: team.project.id,
      type: "FULL_TEXT",
      reviewersPerCitation: 1,
    },
  });
  for (const c of citations) {
    await prisma.citationStageResult.create({
      data: {
        stageId: ta.id,
        citationId: c.id,
        outcome: "INCLUDE",
        resolvedVia: "SINGLE_REVIEWER",
      },
    });
    await prisma.screeningAssignment.create({
      data: { stageId: ft.id, citationId: c.id, reviewerId: team.reviewer1.id },
    });
  }
  return { ...team, ctx, citations, pairs, group, ft };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
const confirm = (f: Fixture, n = 0) =>
  dedup.confirmCompanions(f.ctx, f.project.id, { candidateId: f.pairs[n]!.id });
const confirmAll = (f: Fixture) =>
  dedup.confirmCompanions(f.ctx, f.project.id, {
    groupId: f.group.id,
    confirmed: true,
    candidateIds: f.pairs.map((c) => c.id),
  });
const include = (f: Fixture, n: number) =>
  screening.createDecision({ userId: f.reviewer1.id }, f.project.id, f.ft.id, {
    citationId: f.citations[n]!.id,
    decision: "INCLUDE",
  });
async function expectActive(f: Fixture, count = f.citations.length) {
  expect(
    await prisma.citation.count({
      where: { projectId: f.project.id, status: "ACTIVE", duplicateOfId: null },
    }),
  ).toBe(count);
}
async function addWork(f: Fixture, studyId: string) {
  const template = await prisma.extractionTemplate.create({
    data: {
      projectId: f.project.id,
      name: "Extraction",
      createdById: f.owner.id,
    },
  });
  return prisma.extractionForm.create({
    data: { templateId: template.id, studyId, extractorId: f.owner.id },
  });
}

describe("dedup companion decision and study lifecycle", () => {
  beforeAll(resetDb);
  it("A/B: true duplicates and unrelated reports retain distinct decisions", async () => {
    const a = await fixture();
    await dedup.mergeGroup(a.ctx, a.project.id, a.group.id, {
      canonicalCitationId: a.citations[0]!.id,
    });
    await expectActive(a, 1);
    expect(
      await prisma.citation.findUnique({ where: { id: a.citations[1]!.id } }),
    ).toMatchObject({ status: "DUPLICATE", duplicateOfId: a.citations[0]!.id });
    const b = await fixture();
    await dedup.rejectCandidate(b.ctx, b.project.id, b.pairs[0]!.id);
    await expectActive(b);
    expect(
      await prisma.deduplicationCandidate.findUnique({
        where: { id: b.pairs[0]!.id },
      }),
    ).toMatchObject({ status: "REJECTED" });
    expect(
      await prisma.deduplicationCandidate.count({
        where: { status: "COMPANION" },
      }),
    ).toBe(0);
  });
  it("C/D/E/N: confirms separate reports without creating studies, audits, survives both detection reruns", async () => {
    const f = await fixture();
    await confirm(f);
    await expectActive(f);
    expect(
      await prisma.study.count({ where: { projectId: f.project.id } }),
    ).toBe(0);
    expect(
      await prisma.studyReportLink.count({
        where: { citation: { projectId: f.project.id } },
      }),
    ).toBe(0);
    expect(await dedup.listGroups(f.ctx, f.project.id)).toEqual([]);
    await dedup.runDetection(f.ctx, f.project.id);
    await cohort.runCohortDetection(f.ctx, f.project.id);
    const row = await prisma.deduplicationCandidate.findUniqueOrThrow({
      where: { id: f.pairs[0]!.id },
    });
    expect(row).toMatchObject({ status: "COMPANION", decidedById: f.owner.id });
    expect(row.decidedAt).not.toBeNull();
    expect(
      await prisma.cohortCandidate.count({
        where: { projectId: f.project.id },
      }),
    ).toBe(0);
    const history = await dedup.listGroups(f.ctx, f.project.id, {
      status: "RESOLVED",
    });
    expect(history[0]!.candidates[0]!.status).toBe("COMPANION");
    expect(
      (await cohort.listCohortCandidates(f.ctx, f.project.id))[0],
    ).toMatchObject({
      id: row.id,
      method: "MANUAL_DEDUP",
      status: "COMPANION",
    });
    expect(
      await prisma.auditEvent.findFirst({
        where: { entityId: row.id, action: "dedup.companion_confirmed" },
      }),
    ).toMatchObject({
      projectId: f.project.id,
      userId: f.owner.id,
      previousValue: { status: "SUGGESTED" },
      newValue: { status: "COMPANION" },
      metadata: { citationAId: row.citationAId, citationBId: row.citationBId },
    });
  });
  it("F: splits the graph and carries companion history through a true duplicate merge", async () => {
    const f = await fixture(4, [
      [0, 1],
      [1, 2],
      [2, 3],
    ]);
    await confirm(f, 1);
    expect(await dedup.listGroups(f.ctx, f.project.id)).toHaveLength(2);
    expect(
      (await dedup.listGroups(f.ctx, f.project.id, { status: "RESOLVED" }))
        .flatMap((g) => g.candidates)
        .map((c) => c.id),
    ).toContain(f.pairs[1]!.id);
    await confirm(f, 2);
    const groups = await dedup.listGroups(f.ctx, f.project.id);
    await dedup.mergeGroup(f.ctx, f.project.id, groups[0]!.id, {
      canonicalCitationId: f.citations[0]!.id,
    });
    await include(f, 0);
    await include(f, 2);
    await include(f, 3);
    expect(
      await prisma.study.count({ where: { projectId: f.project.id } }),
    ).toBe(1);
    expect(
      await prisma.studyReportLink.count({
        where: { study: { projectId: f.project.id } },
      }),
    ).toBe(3);
    expect(
      await prisma.deduplicationCandidate.findUnique({
        where: { id: f.pairs[1]!.id },
      }),
    ).toMatchObject({
      citationAId: f.pairs[1]!.citationAId,
      citationBId: f.pairs[1]!.citationBId,
      status: "COMPANION",
    });
    await dedup.runDetection(f.ctx, f.project.id);
    expect(await dedup.listGroups(f.ctx, f.project.id)).toHaveLength(0);
  });
  it.each([
    { sharedFamily: false, bulk: false },
    { sharedFamily: true, bulk: false },
    { sharedFamily: false, bulk: true },
    { sharedFamily: true, bulk: true },
  ])(
    "merges duplicate copies with external companion evidence ($sharedFamily shared family, $bulk bulk)",
    async ({ sharedFamily, bulk }) => {
      // R1 — PubMed —(duplicate)— Embase — R2. An optional R1—Embase
      // judgment puts both copies in the same family BEFORE the duplicate merge.
      const f = await fixture(4, [
        [0, 1],
        [1, 2],
        [2, 3],
        ...(sharedFamily ? [[0, 2] as [number, number]] : []),
      ]);
      const pubmed = f.citations[1]!;
      const embase = f.citations[2]!;
      await prisma.citation.updateMany({
        where: { id: { in: [pubmed.id, embase.id] } },
        data: {
          title:
            "Prospective trial of biodegradable stents for refractory benign esophageal strictures after curative treatment of esophageal cancer",
          normalizedTitle:
            "prospective trial of biodegradable stents for refractory benign esophageal strictures after curative treatment of esophageal cancer",
          doi: "10.1016/j.gie.2017.01.011",
          year: 2017,
          journal: "Gastrointestinal Endoscopy",
        },
      });
      await prisma.citation.update({
        where: { id: pubmed.id },
        data: { pmid: "28137598" },
      });
      await prisma.deduplicationCandidate.update({
        where: { id: f.pairs[1]!.id },
        data: { method: "EXACT_DOI" },
      });
      for (const n of [0, 2, ...(sharedFamily ? [3] : [])]) await confirm(f, n);
      const history = await prisma.deduplicationCandidate.findMany({
        where: { projectId: f.project.id, status: "COMPANION" },
        orderBy: { id: "asc" },
      });
      const before = await companionGraph(prisma, f.project.id);
      expect(before.sameStudy(pubmed.id, embase.id)).toBe(sharedFamily);
      const groups = await dedup.listGroups(f.ctx, f.project.id);
      expect(groups).toHaveLength(1);
      expect(groups[0]!.bulkExactDoiEligible).toBe(true);
      if (bulk) {
        expect(
          await dedup.bulkMergeExactDoiGroups(f.ctx, f.project.id),
        ).toMatchObject({ groupsMerged: 1, citationsMerged: 1 });
      } else {
        await dedup.mergeGroup(f.ctx, f.project.id, groups[0]!.id, {
          canonicalCitationId: pubmed.id,
        });
      }
      expect(
        await prisma.citation.findUnique({ where: { id: embase.id } }),
      ).toMatchObject({ status: "DUPLICATE", duplicateOfId: pubmed.id });
      await expectActive(f, 3);
      expect(
        await prisma.study.count({ where: { projectId: f.project.id } }),
      ).toBe(0);
      const graph = await companionGraph(prisma, f.project.id);
      expect(graph.root(embase.id)).toBe(pubmed.id);
      expect([...graph.members(pubmed.id)].sort()).toEqual(
        [f.citations[0]!.id, pubmed.id, f.citations[3]!.id].sort(),
      );
      expect(graph.edges).toHaveLength(history.length);
      expect(
        graph.edges.every((e) => e.a !== embase.id && e.b !== embase.id),
      ).toBe(true);
      await dedup.runDetection(f.ctx, f.project.id);
      expect(await dedup.listGroups(f.ctx, f.project.id)).toHaveLength(0);
      expect(
        await prisma.deduplicationCandidate.findUnique({
          where: { id: f.pairs[1]!.id },
        }),
      ).toMatchObject({ status: "MERGED" });
      for (const n of [1, 0, 3]) await include(f, n);
      const rows = await studies.listStudies(f.ctx, f.project.id);
      expect(rows).toHaveLength(1);
      expect(rows[0]!.reportLinks.map((l) => l.citationId).sort()).toEqual(
        [f.citations[0]!.id, pubmed.id, f.citations[3]!.id].sort(),
      );
      expect(
        rows[0]!.reportLinks
          .filter((l) => l.isPrimaryReport)
          .map((l) => l.citationId),
      ).toEqual([pubmed.id]);
      const counts = (await computePrismaCounts(f.project.id)).counts;
      expect(counts.find((c) => c.key === "studies_included")?.value).toBe(1);
      expect(counts.find((c) => c.key === "reports_included")?.value).toBe(3);
      expect(
        await prisma.deduplicationCandidate.findMany({
          where: { projectId: f.project.id, status: "COMPANION" },
          orderBy: { id: "asc" },
        }),
      ).toEqual(history);
    },
  );

  it("blocks a historical separate-report judgment after successive canonical replacements", async () => {
    // A—oldB is companion; oldB -> intermediateB -> canonicalB are real merges.
    const f = await fixture(4, [
      [0, 1],
      [1, 2],
    ]);
    await confirm(f, 0);
    const history = await prisma.deduplicationCandidate.findUniqueOrThrow({
      where: { id: f.pairs[0]!.id },
    });
    const group = (await dedup.listGroups(f.ctx, f.project.id))[0]!;
    await dedup.mergeGroup(f.ctx, f.project.id, group.id, {
      canonicalCitationId: f.citations[2]!.id,
    });
    async function suggest(a: number, b: number) {
      const group = await prisma.deduplicationGroup.create({
        data: { projectId: f.project.id },
      });
      const [citationAId, citationBId] = [
        f.citations[a]!.id,
        f.citations[b]!.id,
      ].sort() as [string, string];
      await prisma.deduplicationCandidate.create({
        data: {
          projectId: f.project.id,
          groupId: group.id,
          citationAId,
          citationBId,
          method: "EXACT_DOI",
          score: 1,
          reasons: {},
        },
      });
      return group;
    }
    const replacement = await suggest(2, 3);
    await dedup.mergeGroup(f.ctx, f.project.id, replacement.id, {
      canonicalCitationId: f.citations[3]!.id,
    });
    await prisma.citation.updateMany({
      where: { projectId: f.project.id },
      data: { doi: "10.1234/shared", journal: "Same journal", year: 2024 },
    });
    const unsafe = await suggest(0, 3);
    const citationsBefore = await prisma.citation.findMany({
      where: { projectId: f.project.id },
      orderBy: { id: "asc" },
    });
    expect(
      (await dedup.listGroups(f.ctx, f.project.id))[0]!.bulkExactDoiEligible,
    ).toBe(false);
    expect(
      (await dedup.bulkMergeExactDoiGroups(f.ctx, f.project.id)).groupsMerged,
    ).toBe(0);
    await expect(
      dedup.mergeGroup(f.ctx, f.project.id, unsafe.id, {
        canonicalCitationId: f.citations[0]!.id,
      }),
    ).rejects.toMatchObject({
      code: "INVALID_STATE",
      message:
        "These citations were previously confirmed as separate reports of the same study. Reopen that companion decision before merging them as duplicate citations.",
    });
    expect(
      await prisma.citation.findMany({
        where: { projectId: f.project.id },
        orderBy: { id: "asc" },
      }),
    ).toEqual(citationsBefore);
    expect(
      await prisma.deduplicationCandidate.findUnique({
        where: { id: history.id },
      }),
    ).toEqual(history);
  });

  it("G/H: the five-report cohort resolves to five active reports and one analysis study", async () => {
    const f = await fixture(5);
    expect(f.pairs).toHaveLength(10);
    await confirmAll(f);
    await expectActive(f);
    expect(await dedup.listGroups(f.ctx, f.project.id)).toHaveLength(0);
    expect(
      await prisma.study.count({ where: { projectId: f.project.id } }),
    ).toBe(0);
    for (let n = 0; n < 5; n++) await include(f, n);
    const rows = await studies.listStudies(f.ctx, f.project.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.reportLinks).toHaveLength(5);
    expect(
      rows[0]!.reportLinks
        .filter((l) => l.isPrimaryReport)
        .map((l) => l.citationId),
    ).toEqual([f.citations[0]!.id]);
    const counts = (await computePrismaCounts(f.project.id)).counts;
    expect(counts.find((c) => c.key === "studies_included")?.value).toBe(1);
    expect(counts.find((c) => c.key === "reports_included")?.value).toBe(5);
    expect(
      await prisma.auditEvent.count({
        where: { projectId: f.project.id, action: "study.report_linked" },
      }),
    ).toBe(5);
    expect(
      await prisma.auditEvent.count({
        where: { projectId: f.project.id, action: "dedup.companion_confirmed" },
      }),
    ).toBe(10);
    await cohort.runCohortDetection(f.ctx, f.project.id);
    expect(
      await prisma.cohortCandidate.count({
        where: { projectId: f.project.id },
      }),
    ).toBe(0);
  });
  it("H: simultaneous full-text includes converge, including ordinary reviewer consensus", async () => {
    const f = await fixture(3);
    await confirmAll(f);
    await Promise.all([include(f, 0), include(f, 1), include(f, 2)]);
    expect(
      await prisma.study.count({ where: { projectId: f.project.id } }),
    ).toBe(1);
    expect(
      await prisma.studyReportLink.count({
        where: { study: { projectId: f.project.id } },
      }),
    ).toBe(3);
  });
  it("a companion confirmation racing with inclusion still converges on one study", async () => {
    const f = await fixture();
    await Promise.all([confirm(f), include(f, 0), include(f, 1)]);
    expect(
      await prisma.study.count({ where: { projectId: f.project.id } }),
    ).toBe(1);
    expect(
      await prisma.studyReportLink.count({
        where: { study: { projectId: f.project.id } },
      }),
    ).toBe(2);
  });
  it("failed legacy study reconciliation rolls back the full-text inclusion transaction", async () => {
    const f = await fixture();
    await confirm(f);
    await include(f, 0);
    const legacy = await prisma.study.create({
      data: {
        projectId: f.project.id,
        label: "Legacy second study",
        createdById: f.owner.id,
      },
    });
    await prisma.studyReportLink.create({
      data: {
        studyId: legacy.id,
        citationId: f.citations[1]!.id,
        isPrimaryReport: true,
      },
    });
    await addWork(f, legacy.id);
    await expect(include(f, 1)).rejects.toMatchObject({
      code: "INVALID_STATE",
    });
    expect(
      await prisma.citationStageResult.findUnique({
        where: {
          stageId_citationId: {
            stageId: f.ft.id,
            citationId: f.citations[1]!.id,
          },
        },
      }),
    ).toBeNull();
    expect(
      await prisma.screeningDecision.count({
        where: { stageId: f.ft.id, citationId: f.citations[1]!.id },
      }),
    ).toBe(0);
    expect(
      await prisma.extractionForm.count({ where: { studyId: legacy.id } }),
    ).toBe(1);
  });
  it("manual confirmation supersedes an algorithmic cohort suggestion without storing a duplicate judgment", async () => {
    const f = await fixture();
    await include(f, 0);
    await include(f, 1);
    await cohort.runCohortDetection(f.ctx, f.project.id);
    const algorithmic = await prisma.cohortCandidate.findFirstOrThrow({
      where: { projectId: f.project.id },
    });
    await confirm(f);
    const visible = await cohort.listCohortCandidates(f.ctx, f.project.id);
    expect(visible).toHaveLength(1);
    expect(visible[0]!.status).toBe("COMPANION");
    await expect(
      cohort.rejectCohortCandidate(f.ctx, f.project.id, algorithmic.id),
    ).rejects.toMatchObject({ code: "INVALID_STATE" });
    await expect(
      cohort.linkCohortCandidate(f.ctx, f.project.id, algorithmic.id),
    ).rejects.toMatchObject({ code: "INVALID_STATE" });
    await cohort.runCohortDetection(f.ctx, f.project.id);
    expect(
      await prisma.cohortCandidate.count({
        where: { projectId: f.project.id },
      }),
    ).toBe(0);
  });
  it("I: an excluded intermediate report preserves transitive evidence but receives no analysis link", async () => {
    const f = await fixture(3, [
      [0, 1],
      [1, 2],
    ]);
    await confirmAll(f);
    const reason = await prisma.exclusionReason.create({
      data: {
        projectId: f.project.id,
        label: "Not eligible",
        stage: "FULL_TEXT",
      },
    });
    await screening.createDecision(
      { userId: f.reviewer1.id },
      f.project.id,
      f.ft.id,
      {
        citationId: f.citations[1]!.id,
        decision: "EXCLUDE",
        exclusionReasonId: reason.id,
      },
    );
    await include(f, 0);
    await include(f, 2);
    expect(
      await prisma.studyReportLink.count({
        where: { citationId: f.citations[1]!.id },
      }),
    ).toBe(0);
    expect(
      await prisma.study.count({ where: { projectId: f.project.id } }),
    ).toBe(1);
    expect(
      await prisma.deduplicationCandidate.count({
        where: { projectId: f.project.id, status: "COMPANION" },
      }),
    ).toBe(2);
  });
  it("J: confirming after inclusion reconciles existing empty studies using guarded merge", async () => {
    const f = await fixture();
    await include(f, 0);
    await include(f, 1);
    expect(
      await prisma.study.count({ where: { projectId: f.project.id } }),
    ).toBe(2);
    await confirm(f);
    expect(
      await prisma.study.count({ where: { projectId: f.project.id } }),
    ).toBe(1);
    expect(
      await prisma.auditEvent.count({
        where: { projectId: f.project.id, action: "study.merged" },
      }),
    ).toBe(1);
  });
  it("J: downstream work blocks reconciliation and rolls back the whole decision", async () => {
    const f = await fixture();
    await include(f, 0);
    await include(f, 1);
    for (const s of await prisma.study.findMany({
      where: { projectId: f.project.id },
    }))
      await addWork(f, s.id);
    await expect(confirm(f)).rejects.toMatchObject({
      code: "INVALID_STATE",
      message: expect.stringContaining("reconcile"),
    });
    expect(
      await prisma.study.count({ where: { projectId: f.project.id } }),
    ).toBe(2);
    expect(
      await prisma.extractionForm.count({
        where: { study: { projectId: f.project.id } },
      }),
    ).toBe(2);
    expect(
      await prisma.deduplicationCandidate.findUnique({
        where: { id: f.pairs[0]!.id },
      }),
    ).toMatchObject({ status: "SUGGESTED" });
    expect(
      await prisma.auditEvent.count({
        where: { projectId: f.project.id, action: "dedup.companion_confirmed" },
      }),
    ).toBe(0);
  });
  it("K: reopens a mistaken early decision and permits unrelated reclassification", async () => {
    const f = await fixture();
    await confirm(f);
    await dedup.reopenDecision(f.ctx, f.project.id, f.pairs[0]!.id);
    expect(await dedup.listGroups(f.ctx, f.project.id)).toHaveLength(1);
    await dedup.rejectCandidate(f.ctx, f.project.id, f.pairs[0]!.id);
    await include(f, 0);
    await include(f, 1);
    expect(
      await prisma.study.count({ where: { projectId: f.project.id } }),
    ).toBe(2);
    expect(
      await prisma.auditEvent.findFirst({
        where: { entityId: f.pairs[0]!.id, action: "dedup.decision_reopened" },
      }),
    ).toMatchObject({
      previousValue: { status: "COMPANION", decidedById: f.owner.id },
      newValue: { status: "SUGGESTED" },
    });
  });
  it("L: applied decisions fail closed on undo without unlinking or dropping extraction", async () => {
    const f = await fixture();
    await confirm(f);
    await include(f, 0);
    await include(f, 1);
    const s = await prisma.study.findFirstOrThrow({
      where: { projectId: f.project.id },
    });
    const form = await addWork(f, s.id);
    await expect(
      dedup.reopenDecision(f.ctx, f.project.id, f.pairs[0]!.id),
    ).rejects.toMatchObject({
      code: "INVALID_STATE",
      message: expect.stringContaining("No reports were unlinked"),
    });
    expect(
      await prisma.studyReportLink.count({ where: { studyId: s.id } }),
    ).toBe(2);
    expect(
      await prisma.extractionForm.findUnique({ where: { id: form.id } }),
    ).not.toBeNull();
  });
  it("M: contradictory exact DOI metadata and an alternate graph path never override companions", async () => {
    const f = await fixture(3);
    await prisma.citation.updateMany({
      where: { projectId: f.project.id },
      data: {
        doi: "10.1234/wrong",
        journal: "Same imported journal",
        year: 2024,
      },
    });
    await prisma.deduplicationCandidate.updateMany({
      where: { projectId: f.project.id },
      data: { method: "EXACT_DOI", score: 1 },
    });
    await confirm(f);
    const groups = await dedup.listGroups(f.ctx, f.project.id);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.bulkExactDoiEligible).toBe(false);
    expect(
      (await dedup.bulkMergeExactDoiGroups(f.ctx, f.project.id)).groupsMerged,
    ).toBe(0);
    await expect(
      dedup.mergeGroup(f.ctx, f.project.id, groups[0]!.id, {
        canonicalCitationId: f.citations[0]!.id,
      }),
    ).rejects.toMatchObject({
      code: "INVALID_STATE",
      message:
        "These citations were previously confirmed as separate reports of the same study. Reopen that companion decision before merging them as duplicate citations.",
    });
    await dedup.runDetection(f.ctx, f.project.id);
    await expectActive(f);
  });
  it("permissions, tenancy and stale group confirmation are enforced atomically", async () => {
    const f = await fixture();
    const other = await fixture();
    await expect(
      dedup.confirmCompanions({ userId: f.reviewer1.id }, f.project.id, {
        candidateId: f.pairs[0]!.id,
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(
      dedup.confirmCompanions(other.ctx, other.project.id, {
        candidateId: f.pairs[0]!.id,
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(
      dedup.confirmCompanions(f.ctx, f.project.id, {
        groupId: f.group.id,
        confirmed: true,
        candidateIds: ["stale"],
      }),
    ).rejects.toMatchObject({ code: "INVALID_STATE" });
    await prisma.projectMember.update({
      where: {
        projectId_userId: { projectId: f.project.id, userId: f.reviewer2.id },
      },
      data: { roles: ["LIBRARIAN"] },
    });
    await dedup.confirmCompanions({ userId: f.reviewer2.id }, f.project.id, {
      candidateId: f.pairs[0]!.id,
    });
    await expect(
      dedup.reopenDecision(
        { userId: f.reviewer1.id },
        f.project.id,
        f.pairs[0]!.id,
      ),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    await dedup.reopenDecision(f.ctx, f.project.id, f.pairs[0]!.id);
    await include(f, 0);
    // One existing included report needs no study mutation: normal dedup authority is enough.
    await dedup.confirmCompanions({ userId: f.reviewer2.id }, f.project.id, {
      candidateId: f.pairs[0]!.id,
    });
    await dedup.reopenDecision(f.ctx, f.project.id, f.pairs[0]!.id);
    await include(f, 1);
    await expect(
      dedup.confirmCompanions({ userId: f.reviewer2.id }, f.project.id, {
        candidateId: f.pairs[0]!.id,
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
  it("manual study creation cannot bypass a confirmed companion relationship", async () => {
    const f = await fixture();
    await confirm(f);
    await expect(
      studies.createStudy(f.ctx, f.project.id, {
        label: "Bypass",
        citationId: f.citations[0]!.id,
      }),
    ).rejects.toMatchObject({ code: "INVALID_STATE" });
    const manual = await studies.createStudy(f.ctx, f.project.id, {
      label: "Empty manual study",
    });
    await expect(
      studies.linkReport(f.ctx, f.project.id, manual.id, {
        citationId: f.citations[1]!.id,
      }),
    ).rejects.toMatchObject({ code: "INVALID_STATE" });
    expect(
      await prisma.studyReportLink.count({
        where: { study: { projectId: f.project.id } },
      }),
    ).toBe(0);
  });
});
