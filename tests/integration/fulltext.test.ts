// Full-text domain integration tests (run against srb_test_fulltext — see agent sandbox note).
// Covers R13 upload policy, sha256 reuse, tenant-scoped serving, retrieval attempts, and the
// FT queue with derived retrieval statuses.
import { createHash } from "node:crypto";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/server/db";
import { AppError } from "@/server/errors";
import * as ft from "@/server/services/fulltext";
import { getStorage } from "@/server/storage";
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
process.env.STORAGE_DIR = mkdtempSync(path.join(os.tmpdir(), "srb-fulltext-it-"));

const ctx = (userId: string) => ({ userId });
const PDF = Buffer.from("%PDF-1.4\n%fake pdf body for tests");

async function expectAppError(promise: Promise<unknown>, code: string) {
  try {
    await promise;
    expect.fail(`expected AppError(${code}) but call succeeded`);
  } catch (err) {
    if (!(err instanceof AppError)) throw err;
    expect(err.code).toBe(code);
  }
}

// Local helpers — stage rows + materialized TA results created directly via prisma
// (screening services are another agent's domain).
async function createStages(projectId: string) {
  const ta = await prisma.screeningStage.create({
    data: { projectId, type: "TITLE_ABSTRACT" },
  });
  const ftStage = await prisma.screeningStage.create({
    data: { projectId, type: "FULL_TEXT" },
  });
  return { ta, ftStage };
}

async function includeAtStage(stageId: string, citationId: string) {
  return prisma.citationStageResult.create({
    data: { stageId, citationId, outcome: "INCLUDE", resolvedVia: "CONSENSUS" },
  });
}

describe("fulltext service", () => {
  beforeAll(async () => {
    await resetDb();
  });

  it("rejects non-PDF bytes with VALIDATION", async () => {
    const { owner, project } = await createProjectWithTeam();
    const citation = await createTestCitation(project.id);
    await expectAppError(
      ft.uploadFullText(ctx(owner.id), project.id, {
        citationId: citation.id,
        filename: "not-a-pdf.pdf",
        bytes: Buffer.from("hello, i am definitely not a pdf"),
      }),
      "VALIDATION",
    );
    expect(await prisma.fullTextFile.count({ where: { projectId: project.id } })).toBe(0);
  });

  it("rejects files over 50 MB with INVALID_STATE", async () => {
    const { owner, project } = await createProjectWithTeam();
    const citation = await createTestCitation(project.id);
    const big = Buffer.alloc(ft.MAX_PDF_BYTES + 1);
    big.write("%PDF-1.4", 0, "latin1");
    await expectAppError(
      ft.uploadFullText(ctx(owner.id), project.id, {
        citationId: citation.id,
        filename: "big.pdf",
        bytes: big,
      }),
      "INVALID_STATE",
    );
  });

  it("uploads a PDF: file + link + audit + sha256 + forced content type", async () => {
    const { owner, reviewer1, project } = await createProjectWithTeam();
    const citation = await createTestCitation(project.id);

    const { file, link, reused } = await ft.uploadFullText(ctx(owner.id), project.id, {
      citationId: citation.id,
      filename: "Smith 2020 (final).pdf",
      bytes: PDF,
      label: "main paper",
    });

    expect(reused).toBe(false);
    expect(file.contentType).toBe("application/pdf");
    expect(file.sizeBytes).toBe(PDF.length);
    expect(file.sha256).toBe(createHash("sha256").update(PDF).digest("hex"));
    expect(file.storageKey.startsWith(`${project.id}/`)).toBe(true);
    expect(link.citationId).toBe(citation.id);
    expect(link.label).toBe("main paper");

    // bytes actually landed in storage
    await expect(getStorage().get(file.storageKey)).resolves.toEqual(PDF);

    const event = await prisma.auditEvent.findFirstOrThrow({
      where: { entityType: "FullTextFile", entityId: file.id, action: "fulltext.file.uploaded" },
    });
    expect(event.userId).toBe(owner.id);
    expect(event.newValue).toMatchObject({ sha256: file.sha256, citationId: citation.id });

    // REVIEWER is assignment-gated screening work only; it cannot administer full-text files.
    await expectAppError(
      ft.uploadFullText(ctx(reviewer1.id), project.id, {
        citationId: citation.id,
        filename: "reviewer-copy.pdf",
        bytes: Buffer.from(`%PDF-1.4\n%${uniq("reviewer-copy")}`),
      }),
      "FORBIDDEN",
    );
  });

  it("reuses the same-sha256 file: one FullTextFile, two links, LINKED audit", async () => {
    const { owner, project } = await createProjectWithTeam();
    const c1 = await createTestCitation(project.id);
    const c2 = await createTestCitation(project.id);
    const bytes = Buffer.from(`%PDF-1.4\n%${uniq("dedup")}`);

    const first = await ft.uploadFullText(ctx(owner.id), project.id, {
      citationId: c1.id,
      filename: "a.pdf",
      bytes,
    });
    const second = await ft.uploadFullText(ctx(owner.id), project.id, {
      citationId: c2.id,
      filename: "b.pdf",
      bytes,
    });

    expect(second.reused).toBe(true);
    expect(second.file.id).toBe(first.file.id);
    expect(
      await prisma.fullTextFile.count({ where: { projectId: project.id, sha256: first.file.sha256 } }),
    ).toBe(1);
    expect(await prisma.citationFullTextLink.count({ where: { fileId: first.file.id } })).toBe(2);

    await prisma.auditEvent.findFirstOrThrow({
      where: {
        entityType: "CitationFullTextLink",
        entityId: second.link.id,
        action: "fulltext.file.linked",
      },
    });

    // idempotent: same bytes to the same citation adds nothing
    const third = await ft.uploadFullText(ctx(owner.id), project.id, {
      citationId: c2.id,
      filename: "b.pdf",
      bytes,
    });
    expect(third.linkCreated).toBe(false);
    expect(await prisma.citationFullTextLink.count({ where: { fileId: first.file.id } })).toBe(2);
  });

  it("upload validates the citation belongs to the project and is ACTIVE", async () => {
    const { owner, project } = await createProjectWithTeam();
    const other = await createProjectWithTeam();
    const foreign = await createTestCitation(other.project.id);
    await expectAppError(
      ft.uploadFullText(ctx(owner.id), project.id, {
        citationId: foreign.id,
        filename: "x.pdf",
        bytes: PDF,
      }),
      "NOT_FOUND",
    );

    const dup = await createTestCitation(project.id);
    await prisma.citation.update({ where: { id: dup.id }, data: { status: "DUPLICATE" } });
    await expectAppError(
      ft.uploadFullText(ctx(owner.id), project.id, {
        citationId: dup.id,
        filename: "x.pdf",
        bytes: PDF,
      }),
      "NOT_FOUND",
    );
  });

  it("serves file bytes to members; non-members get FORBIDDEN; missing object → 404", async () => {
    const { owner, project, org } = await createProjectWithTeam();
    const citation = await createTestCitation(project.id);
    const { file } = await ft.uploadFullText(ctx(owner.id), project.id, {
      citationId: citation.id,
      filename: "serve-me.pdf",
      bytes: PDF,
    });

    const served = await ft.getFileForServing(ctx(owner.id), file.id);
    expect(served.bytes).toEqual(PDF);
    expect(served.file.id).toBe(file.id);

    // complete stranger
    const stranger = await createTestUser();
    await expectAppError(ft.getFileForServing(ctx(stranger.id), file.id), "FORBIDDEN");
    // org member without project membership
    const orgOnly = await createTestUser();
    await addOrgMember(org.id, orgOnly.id);
    await expectAppError(ft.getFileForServing(ctx(orgOnly.id), file.id), "FORBIDDEN");

    // unknown id
    await expectAppError(ft.getFileForServing(ctx(owner.id), "nope"), "NOT_FOUND");

    // storage object vanished → 404
    await getStorage().delete(file.storageKey);
    await expectAppError(ft.getFileForServing(ctx(owner.id), file.id), "NOT_FOUND");
  });

  it("links an existing file to another citation; tenancy + duplicates enforced", async () => {
    const { owner, project } = await createProjectWithTeam();
    const c1 = await createTestCitation(project.id);
    const c2 = await createTestCitation(project.id);
    const { file } = await ft.uploadFullText(ctx(owner.id), project.id, {
      citationId: c1.id,
      filename: "linkable.pdf",
      bytes: Buffer.from(`%PDF-1.4\n%${uniq("link")}`),
    });

    const link = await ft.linkFileToCitation(ctx(owner.id), project.id, file.id, {
      citationId: c2.id,
      label: "supplement",
    });
    expect(link.label).toBe("supplement");
    await prisma.auditEvent.findFirstOrThrow({
      where: { entityType: "CitationFullTextLink", entityId: link.id, action: "fulltext.file.linked" },
    });

    // duplicate link
    await expectAppError(
      ft.linkFileToCitation(ctx(owner.id), project.id, file.id, { citationId: c2.id }),
      "CONFLICT",
    );
    // citation from another project
    const other = await createProjectWithTeam();
    const foreign = await createTestCitation(other.project.id);
    await expectAppError(
      ft.linkFileToCitation(ctx(owner.id), project.id, file.id, { citationId: foreign.id }),
      "NOT_FOUND",
    );
    // file from another project
    await expectAppError(
      ft.linkFileToCitation(ctx(other.owner.id), other.project.id, file.id, {
        citationId: foreign.id,
      }),
      "NOT_FOUND",
    );
  });

  it("records and lists retrieval attempts with recorder names; permission enforced", async () => {
    const { owner, reviewer1, adjudicator, project } = await createProjectWithTeam();
    const citation = await createTestCitation(project.id);

    const attempt = await ft.recordRetrievalAttempt(ctx(adjudicator.id), project.id, citation.id, {
      method: "publisher site",
      outcome: "NOT_RETRIEVED",
      notes: "paywalled",
    });
    expect(attempt.outcome).toBe("NOT_RETRIEVED");
    await prisma.auditEvent.findFirstOrThrow({
      where: {
        entityType: "FullTextRetrievalAttempt",
        entityId: attempt.id,
        action: "fulltext.retrieval.recorded",
      },
    });

    await ft.recordRetrievalAttempt(ctx(owner.id), project.id, citation.id, {
      method: "interlibrary loan",
      outcome: "PENDING",
    });

    const attempts = await ft.listRetrievalAttempts(ctx(owner.id), project.id, citation.id);
    expect(attempts).toHaveLength(2);
    expect(attempts[0]!.method).toBe("interlibrary loan"); // newest first
    expect(attempts.map((a) => a.recordedBy.name).sort()).toEqual(["Adjudicator", "Owner"]);

    await expectAppError(
      ft.recordRetrievalAttempt(ctx(reviewer1.id), project.id, citation.id, {
        method: "reviewer upload",
        outcome: "PENDING",
      }),
      "FORBIDDEN",
    );

    // OBSERVER lacks fulltext.manage
    const observer = await createTestUser();
    await addOrgMember((await prisma.project.findUniqueOrThrow({ where: { id: project.id } })).orgId, observer.id);
    await addProjectMember(project.id, observer.id, ["OBSERVER"]);
    await expectAppError(
      ft.recordRetrievalAttempt(ctx(observer.id), project.id, citation.id, {
        method: "author email",
        outcome: "PENDING",
      }),
      "FORBIDDEN",
    );
    // ...but can read the queue/attempts (project.view)
    expect(await ft.listRetrievalAttempts(ctx(observer.id), project.id, citation.id)).toHaveLength(2);
  });

  it("queue: TA-included citations only, derived retrieval statuses, FT result + decision COUNT", async () => {
    const { owner, reviewer1, project } = await createProjectWithTeam();
    const { ta, ftStage } = await createStages(project.id);

    const included = await createTestCitation(project.id, { title: `${uniq("Included")} trial` });
    const notIncluded = await createTestCitation(project.id);
    const excluded = await createTestCitation(project.id);
    await includeAtStage(ta.id, included.id);
    await prisma.citationStageResult.create({
      data: { stageId: ta.id, citationId: excluded.id, outcome: "EXCLUDE", resolvedVia: "CONSENSUS" },
    });

    // 1) no attempts, no files → PENDING
    let queue = await ft.getFullTextQueue(ctx(owner.id), project.id);
    expect(queue).toHaveLength(1);
    expect(queue[0]!.citation.id).toBe(included.id);
    expect(queue[0]!.retrievalStatus).toBe("PENDING");
    expect(queue[0]!.files).toHaveLength(0);
    expect(queue[0]!.latestRetrievalAttempt).toBeNull();
    expect(queue.some((i) => i.citation.id === notIncluded.id)).toBe(false);
    expect(queue.some((i) => i.citation.id === excluded.id)).toBe(false);

    // 2) failed attempt, still no file → NOT_RETRIEVED
    await ft.recordRetrievalAttempt(ctx(owner.id), project.id, included.id, {
      method: "publisher site",
      outcome: "NOT_RETRIEVED",
    });
    queue = await ft.getFullTextQueue(ctx(owner.id), project.id);
    expect(queue[0]!.retrievalStatus).toBe("NOT_RETRIEVED");
    expect(queue[0]!.latestRetrievalAttempt).toMatchObject({
      method: "publisher site",
      outcome: "NOT_RETRIEVED",
    });

    // filter matches the derived status
    expect(await ft.getFullTextQueue(ctx(owner.id), project.id, { retrieval: "pending" })).toHaveLength(0);
    expect(
      await ft.getFullTextQueue(ctx(owner.id), project.id, { retrieval: "not_retrieved" }),
    ).toHaveLength(1);

    // 3) upload a PDF → RETRIEVED (file presence wins over the failed attempt)
    const { file } = await ft.uploadFullText(ctx(owner.id), project.id, {
      citationId: included.id,
      filename: "found-it.pdf",
      bytes: Buffer.from(`%PDF-1.4\n%${uniq("queue")}`),
    });
    queue = await ft.getFullTextQueue(ctx(owner.id), project.id);
    expect(queue[0]!.retrievalStatus).toBe("RETRIEVED");
    expect(queue[0]!.files).toEqual([
      { id: file.id, filename: "found-it.pdf", label: null },
    ]);
    expect(await ft.getFullTextQueue(ctx(owner.id), project.id, { retrieval: "retrieved" })).toHaveLength(1);
    expect(
      await ft.getFullTextQueue(ctx(owner.id), project.id, { retrieval: "not_retrieved" }),
    ).toHaveLength(0);

    // 4) FT decisions are exposed as a COUNT only (blinding), FT stage result surfaces
    await prisma.screeningDecision.create({
      data: {
        stageId: ftStage.id,
        citationId: included.id,
        reviewerId: reviewer1.id,
        decision: "INCLUDE",
      },
    });
    await includeAtStage(ftStage.id, included.id);
    queue = await ft.getFullTextQueue(ctx(owner.id), project.id);
    expect(queue[0]!.fullTextDecisionCount).toBe(1);
    expect(queue[0]!.fullTextResult).toMatchObject({ outcome: "INCLUDE", resolvedVia: "CONSENSUS" });
    expect(queue[0]).not.toHaveProperty("decisions");

    // non-member cannot read the queue
    const stranger = await createTestUser();
    await expectAppError(ft.getFullTextQueue(ctx(stranger.id), project.id), "FORBIDDEN");
  });

  it("limits a plain reviewer full-text view to assigned citations", async () => {
    const { owner, reviewer1, project } = await createProjectWithTeam();
    const { ta, ftStage } = await createStages(project.id);
    const assigned = await createTestCitation(project.id);
    const unassigned = await createTestCitation(project.id);
    await includeAtStage(ta.id, assigned.id);
    await includeAtStage(ta.id, unassigned.id);
    await prisma.screeningAssignment.create({
      data: { stageId: ftStage.id, citationId: assigned.id, reviewerId: reviewer1.id },
    });

    const reviewerQueue = await ft.getFullTextQueue(ctx(reviewer1.id), project.id);
    expect(reviewerQueue).toHaveLength(1);
    expect(reviewerQueue[0]).toMatchObject({
      citation: { id: assigned.id },
      myAssignmentStatus: "PENDING",
    });

    const ownerQueue = await ft.getFullTextQueue(ctx(owner.id), project.id);
    expect(ownerQueue).toHaveLength(2);
    expect(ownerQueue.every((item) => item.myAssignmentStatus === null)).toBe(true);
  });

  it("queue is empty when the project has no TITLE_ABSTRACT stage", async () => {
    const { owner, project } = await createProjectWithTeam();
    expect(await ft.getFullTextQueue(ctx(owner.id), project.id)).toEqual([]);
  });
});
