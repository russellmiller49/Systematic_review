import { beforeAll, expect, it } from "vitest";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/server/db";
import * as dedup from "@/server/services/dedup";
import * as imports from "@/server/services/imports";
import { resetDb } from "../db-utils";
import { createProjectWithTeam } from "../factories";

beforeAll(resetDb);

it("shows publication evidence for existing imports and excludes conference/full-publication pairs from bulk merging", async () => {
  const { owner, project } = await createProjectWithTeam();
  const ctx = { userId: owner.id };
  const title = "Results of a randomized comparison of two treatments";
  const inputs = [
    {
      name: "Embase",
      format: "RIS" as const,
      content: `TY  - JOUR\nTI  - ${title}\nM3  - Conference Abstract\nAB  - Preliminary results in 40 participants.\nDO  - 10.1234/shared\nER  -`,
    },
    {
      name: "PubMed",
      format: "NBIB" as const,
      content: `PMID- 12345678\nTI  - ${title}\nPT  - Journal Article\nAB  - Final results in 120 participants.\nAID - 10.1234/shared [doi]`,
    },
  ];
  for (const input of inputs) {
    const source = await imports.createImportSource(ctx, project.id, {
      name: input.name,
    });
    const batch = await imports.createBatch(ctx, project.id, {
      sourceId: source.id,
      filename: `records.${input.format.toLowerCase()}`,
      format: input.format,
      content: input.content,
    });
    await imports.commitBatch(ctx, project.id, batch.id);
    // Simulate an import created before publicationTypes were captured in parsed JSON.
    if (input.name === "Embase") {
      const record = await prisma.citationSourceRecord.findFirstOrThrow({
        where: { batchId: batch.id },
      });
      const parsed = { ...(record.parsed as Record<string, unknown>) };
      delete parsed.publicationTypes;
      await prisma.citationSourceRecord.update({
        where: { id: record.id },
        data: { parsed: parsed as Prisma.InputJsonValue },
      });
    }
  }
  await dedup.runDetection(ctx, project.id);
  const [group] = await dedup.listGroups(ctx, project.id);
  expect(group!.bulkExactDoiEligible).toBe(false);
  const { citationA, citationB } = group!.candidates[0]!;
  const citations = [citationA, citationB];
  expect(citations.find((c) => c.publication.kind === "conference")).toMatchObject({
    abstract: "Preliminary results in 40 participants.",
    publication: {
      sources: ["Embase"],
      types: ["JOUR", "Conference Abstract"],
    },
  });
  expect(citations.find((c) => c.publication.kind === "journal")).toMatchObject({
    abstract: "Final results in 120 participants.",
    publication: { sources: ["PubMed"], types: ["Journal Article"] },
  });
  expect(citationA).not.toHaveProperty("sourceRecords");
  expect(citationB).not.toHaveProperty("sourceRecords");
  expect(await dedup.bulkMergeExactDoiGroups(ctx, project.id)).toMatchObject({
    groupsMerged: 0,
    groupsSkippedForReview: 1,
    citationsMerged: 0,
  });
  expect(
    await prisma.citation.count({
      where: { projectId: project.id, status: "ACTIVE" },
    }),
  ).toBe(2);
});
