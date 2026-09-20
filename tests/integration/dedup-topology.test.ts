import { beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/server/db";
import * as dedup from "@/server/services/dedup";
import { lockDedupProject, normalizeGroups } from "@/server/services/dedup/groups";
import { resetDb } from "../db-utils";
import { createProjectWithTeam, createTestCitation } from "../factories";

async function fixture(count: number, edges: [number, number][]) {
  const team = await createProjectWithTeam();
  const ctx = { userId: team.owner.id };
  const citations = [];
  for (let i = 0; i < count; i++)
    citations.push(
      await createTestCitation(team.project.id, {
        title: `Record ${i} of the same synthetic publication`,
        doi: "10.1234/article",
      }),
    );
  const group = await prisma.deduplicationGroup.create({
    data: { projectId: team.project.id },
  });
  const pairs = [];
  for (const [a, b] of edges) {
    const [citationAId, citationBId] = [citations[a]!.id, citations[b]!.id].sort();
    pairs.push(
      await prisma.deduplicationCandidate.create({
        data: {
          projectId: team.project.id,
          groupId: group.id,
          citationAId: citationAId!,
          citationBId: citationBId!,
          method: "EXACT_DOI",
          score: 1,
          reasons: {},
        },
      }),
    );
  }
  return { ...team, ctx, citations, group, pairs };
}
const members = (group: Awaited<ReturnType<typeof dedup.listGroups>>[number]) =>
  [
    ...new Set(
      group.candidates
        .filter((c) => c.status === "SUGGESTED")
        .flatMap((c) => [c.citationAId, c.citationBId]),
    ),
  ].sort();
async function normalize(projectId: string) {
  return prisma.$transaction(async (tx) => {
    await lockDedupProject(tx, projectId);
    return normalizeGroups(tx, projectId);
  });
}

describe("dedup topology safety", () => {
  beforeAll(resetDb);

  it.each([0, 1])("A: a simple pair can retain either member (%i)", async (canonicalIndex) => {
    const f = await fixture(2, [[0, 1]]);
    await dedup.mergeGroup(f.ctx, f.project.id, f.group.id, {
      canonicalCitationId: f.citations[canonicalIndex]!.id,
    });
    expect(
      await prisma.citation.count({
        where: { projectId: f.project.id, status: "ACTIVE" },
      }),
    ).toBe(1);
    expect(
      await prisma.citation.findUnique({
        where: { id: f.citations[1 - canonicalIndex]!.id },
      }),
    ).toMatchObject({
      status: "DUPLICATE",
      duplicateOfId: f.citations[canonicalIndex]!.id,
    });
  });

  it("B: a legitimate transitive cluster merges; partial undo excludes inactive endpoints", async () => {
    const f = await fixture(3, [
      [0, 1],
      [1, 2],
    ]);
    await dedup.mergeGroup(f.ctx, f.project.id, f.group.id, {
      canonicalCitationId: f.citations[0]!.id,
    });
    await dedup.undoMerge(f.ctx, f.project.id, f.citations[2]!.id);
    expect(await dedup.listGroups(f.ctx, f.project.id)).toEqual([]);
    await dedup.undoMerge(f.ctx, f.project.id, f.citations[1]!.id);
    const groups = await dedup.listGroups(f.ctx, f.project.id);
    expect(groups).toHaveLength(1);
    expect(members(groups[0]!)).toEqual(f.citations.map((c) => c.id).sort());
    await dedup.mergeGroup(f.ctx, f.project.id, groups[0]!.id, {
      canonicalCitationId: f.citations[2]!.id,
    });
    expect(
      await prisma.citation.count({
        where: {
          projectId: f.project.id,
          status: "DUPLICATE",
          duplicateOfId: f.citations[2]!.id,
        },
      }),
    ).toBe(2);
  });

  it("C: rejecting a bridge immediately splits groups and merges stay independent", async () => {
    const f = await fixture(4, [
      [0, 1],
      [1, 2],
      [2, 3],
    ]);
    await dedup.rejectCandidate(f.ctx, f.project.id, f.pairs[1]!.id);
    // Assert persistence before any listing/detection can repair it.
    const rows = await prisma.deduplicationGroup.findMany({
      where: { projectId: f.project.id, status: "OPEN" },
      include: { candidates: { where: { status: "SUGGESTED" } } },
    });
    expect(rows).toHaveLength(2);
    expect(rows.every((row) => row.candidates.length === 1)).toBe(true);
    const groups = await dedup.listGroups(f.ctx, f.project.id);
    const a = groups.find((g) => members(g).includes(f.citations[0]!.id))!;
    const b = groups.find((g) => members(g).includes(f.citations[2]!.id))!;
    await dedup.mergeGroup(f.ctx, f.project.id, a.id, {
      canonicalCitationId: f.citations[0]!.id,
    });
    expect(
      await prisma.citation.count({
        where: {
          id: { in: f.citations.slice(2).map((c) => c.id) },
          status: "ACTIVE",
        },
      }),
    ).toBe(2);
    await dedup.mergeGroup(f.ctx, f.project.id, b.id, {
      canonicalCitationId: f.citations[2]!.id,
    });
    expect(await prisma.citation.findUnique({ where: { id: f.citations[1]!.id } })).toMatchObject({
      duplicateOfId: f.citations[0]!.id,
    });
    expect(await prisma.citation.findUnique({ where: { id: f.citations[3]!.id } })).toMatchObject({
      duplicateOfId: f.citations[2]!.id,
    });
    await dedup.undoMerge(f.ctx, f.project.id, f.citations[1]!.id);
    expect(
      await prisma.deduplicationCandidate.findUnique({
        where: { id: f.pairs[1]!.id },
      }),
    ).toMatchObject({ status: "REJECTED" });
    expect((await dedup.listGroups(f.ctx, f.project.id)).map(members)).toEqual([
      f.citations
        .slice(0, 2)
        .map((c) => c.id)
        .sort(),
    ]);
  });

  it("D: rejecting the singleton edge removes that citation from open groups", async () => {
    const f = await fixture(3, [
      [0, 1],
      [0, 2],
    ]);
    await dedup.rejectCandidate(f.ctx, f.project.id, f.pairs[1]!.id);
    expect((await dedup.listGroups(f.ctx, f.project.id)).map(members)).toEqual([
      f.citations
        .slice(0, 2)
        .map((c) => c.id)
        .sort(),
    ]);
    await expect(
      dedup.mergeGroup(f.ctx, f.project.id, f.group.id, {
        canonicalCitationId: f.citations[2]!.id,
      }),
    ).rejects.toMatchObject({ code: "INVALID_STATE" });
  });

  it("E: malformed disconnected membership fails closed without writes; refresh repairs it", async () => {
    const f = await fixture(4, [
      [0, 1],
      [2, 3],
    ]);
    const before = await prisma.deduplicationCandidate.findMany({
      where: { projectId: f.project.id },
    });
    await expect(
      dedup.mergeGroup(f.ctx, f.project.id, f.group.id, {
        canonicalCitationId: f.citations[0]!.id,
      }),
    ).rejects.toMatchObject({ code: "INVALID_STATE" });
    expect(
      await prisma.citation.count({
        where: { projectId: f.project.id, status: "DUPLICATE" },
      }),
    ).toBe(0);
    expect(
      await prisma.auditEvent.count({
        where: { projectId: f.project.id, action: "dedup.merged" },
      }),
    ).toBe(0);
    expect(
      await prisma.deduplicationCandidate.findMany({
        where: { projectId: f.project.id },
      }),
    ).toEqual(before);
    const repaired = await dedup.listGroups(f.ctx, f.project.id);
    expect(repaired).toHaveLength(2);
    await normalize(f.project.id);
    expect(await dedup.listGroups(f.ctx, f.project.id)).toEqual(repaired);
  });

  it("fails closed for inactive endpoints and a component spread across groups", async () => {
    const f = await fixture(3, [
      [0, 1],
      [1, 2],
    ]);
    const other = await prisma.deduplicationGroup.create({
      data: { projectId: f.project.id },
    });
    await prisma.deduplicationCandidate.update({
      where: { id: f.pairs[1]!.id },
      data: { groupId: other.id },
    });
    await expect(
      dedup.mergeGroup(f.ctx, f.project.id, f.group.id, {
        canonicalCitationId: f.citations[0]!.id,
      }),
    ).rejects.toMatchObject({ code: "INVALID_STATE" });
    await prisma.citation.update({
      where: { id: f.citations[1]!.id },
      data: { status: "DUPLICATE", duplicateOfId: f.citations[2]!.id },
    });
    await expect(
      dedup.mergeGroup(f.ctx, f.project.id, f.group.id, {
        canonicalCitationId: f.citations[0]!.id,
      }),
    ).rejects.toMatchObject({ code: "INVALID_STATE" });
  });

  it("G/H: conflicting DOI clusters stay open; clean normalized DOI clusters remain bulk eligible", async () => {
    const f = await fixture(3, [
      [0, 1],
      [1, 2],
    ]);
    await prisma.citation.update({
      where: { id: f.citations[0]!.id },
      data: { pmid: "1111" },
    });
    await prisma.citation.update({
      where: { id: f.citations[2]!.id },
      data: { pmid: "2222" },
    });
    const [group] = await dedup.listGroups(f.ctx, f.project.id);
    expect(group).toMatchObject({
      metadataConflicts: ["Same DOI but different PMIDs"],
      bulkExactDoiEligible: false,
    });
    expect(await dedup.bulkMergeExactDoiGroups(f.ctx, f.project.id)).toMatchObject({
      groupsMerged: 0,
      groupsSkippedForReview: 1,
    });
    expect(
      await prisma.citation.count({
        where: { projectId: f.project.id, status: "ACTIVE" },
      }),
    ).toBe(3);
    // Derived from current metadata: correcting the imported field needs no detection run.
    await prisma.citation.update({
      where: { id: f.citations[2]!.id },
      data: { pmid: "1111", doi: "https://doi.org/10.1234/ARTICLE" },
    });
    expect((await dedup.listGroups(f.ctx, f.project.id))[0]).toMatchObject({
      metadataConflicts: [],
      bulkExactDoiEligible: true,
    });
    expect(await dedup.bulkMergeExactDoiGroups(f.ctx, f.project.id)).toMatchObject({
      groupsMerged: 1,
      citationsMerged: 2,
    });
  });

  it("F/I: wrong DOI bridge and singleton stay separated after rejection, rerun, merge and undo", async () => {
    const team = await createProjectWithTeam();
    const ctx = { userId: team.owner.id },
      projectId = team.project.id;
    const a1 = await createTestCitation(projectId, {
      title: "Safety of airway stenting in patients with malignant fistula",
      doi: "10.1234/a",
      pmid: "29997935",
      year: 2018,
    });
    const a2 = await createTestCitation(projectId, {
      title: a1.title,
      doi: "10.1234/b",
      pmid: a1.pmid,
      year: 2018,
    });
    const b1 = await createTestCitation(projectId, {
      title: "Combined airway and oesophageal stents prospective study",
      doi: "10.1234/b",
      pmid: "20525708",
      year: 2010,
    });
    const b2 = await createTestCitation(projectId, {
      title: b1.title,
      doi: b1.doi,
      pmid: b1.pmid,
      year: 2010,
    });
    const c = await createTestCitation(projectId, {
      title: "Safety of airway stenting with supplementary feeding in cancer",
      doi: "10.1234/c",
      pmid: "33333333",
      year: 2018,
    });
    expect(await dedup.runDetection(ctx, projectId)).toMatchObject({
      groupsOpen: 1,
    });
    const initial = (await dedup.listGroups(ctx, projectId))[0]!;
    expect(members(initial)).toHaveLength(5);
    expect(initial.metadataConflicts).toContain("Same DOI but different PMIDs");
    expect(initial.metadataConflicts).toContain("Same PMID but different DOIs");
    expect(await dedup.bulkMergeExactDoiGroups(ctx, projectId)).toMatchObject({
      groupsMerged: 0,
    });
    const publication = new Map([
      [a1.id, "A"],
      [a2.id, "A"],
      [b1.id, "B"],
      [b2.id, "B"],
      [c.id, "C"],
    ]);
    const falsePairs = initial.candidates.filter(
      (p) => publication.get(p.citationAId) !== publication.get(p.citationBId),
    );
    for (const pair of falsePairs) await dedup.rejectCandidate(ctx, projectId, pair.id);
    const beforeRerun = await dedup.listGroups(ctx, projectId);
    expect(beforeRerun.map(members)).toEqual(
      expect.arrayContaining([[a1.id, a2.id].sort(), [b1.id, b2.id].sort()]),
    );
    expect(beforeRerun).toHaveLength(2);
    await dedup.runDetection(ctx, projectId);
    expect(
      await prisma.deduplicationCandidate.count({
        where: { id: { in: falsePairs.map((p) => p.id) }, status: "REJECTED" },
      }),
    ).toBe(falsePairs.length);
    const groups = await dedup.listGroups(ctx, projectId);
    expect(groups.map((g) => g.id).sort()).toEqual(beforeRerun.map((g) => g.id).sort());
    for (const [canonical, duplicate] of [
      [a1, a2],
      [b1, b2],
    ]) {
      const group = groups.find((g) => members(g).includes(canonical!.id))!;
      const result = await dedup.mergeGroup(ctx, projectId, group.id, {
        canonicalCitationId: canonical!.id,
      });
      expect(result.mergedCitationIds).toEqual([duplicate!.id]);
    }
    expect(await prisma.citation.findUnique({ where: { id: c.id } })).toMatchObject({
      status: "ACTIVE",
      duplicateOfId: null,
    });
    await dedup.undoMerge(ctx, projectId, a2.id);
    expect((await dedup.listGroups(ctx, projectId)).map(members)).toEqual([[a1.id, a2.id].sort()]);
  });

  it("serializes concurrent rejections without losing a split", async () => {
    const f = await fixture(5, [
      [0, 1],
      [1, 2],
      [2, 3],
      [3, 4],
    ]);
    await Promise.all([
      dedup.rejectCandidate(f.ctx, f.project.id, f.pairs[1]!.id),
      dedup.rejectCandidate(f.ctx, f.project.id, f.pairs[2]!.id),
    ]);
    expect((await dedup.listGroups(f.ctx, f.project.id)).map(members)).toEqual(
      expect.arrayContaining([
        f.citations
          .slice(0, 2)
          .map((c) => c.id)
          .sort(),
        f.citations
          .slice(3)
          .map((c) => c.id)
          .sort(),
      ]),
    );
  });

  it("never merges foreign-project endpoints or reuses foreign group IDs", async () => {
    const f = await fixture(2, [[0, 1]]),
      other = await fixture(2, [[0, 1]]);
    await prisma.deduplicationCandidate.update({
      where: { id: f.pairs[0]!.id },
      data: { citationBId: other.citations[1]!.id },
    });
    await expect(
      dedup.mergeGroup(f.ctx, f.project.id, f.group.id, {
        canonicalCitationId: f.citations[0]!.id,
      }),
    ).rejects.toMatchObject({ code: "INVALID_STATE" });
    await normalize(f.project.id);
    expect(
      await prisma.deduplicationCandidate.findUnique({
        where: { id: f.pairs[0]!.id },
      }),
    ).toMatchObject({ groupId: null, status: "SUGGESTED" });
    const foreignBefore = await prisma.deduplicationGroup.findUnique({
      where: { id: other.group.id },
    });
    await prisma.deduplicationCandidate.update({
      where: { id: f.pairs[0]!.id },
      data: { citationBId: f.citations[1]!.id, groupId: other.group.id },
    });
    await normalize(f.project.id);
    expect(
      await prisma.deduplicationGroup.findUnique({
        where: { id: other.group.id },
      }),
    ).toEqual(foreignBefore);
    expect((await dedup.listGroups(f.ctx, f.project.id))[0]!.id).not.toBe(other.group.id);
  });
});
