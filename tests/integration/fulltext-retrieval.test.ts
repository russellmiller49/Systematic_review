// Institutional library access: org library settings (links) + OA auto-fetch runs.
// External HTTP is faked via setHttpClientForTests; storage goes to a temp dir.
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/server/db";
import { AppError } from "@/server/errors";
import { resetHttpClientForTests, setHttpClientForTests } from "@/server/http/client";
import * as orgs from "@/server/services/orgs";
import * as ft from "@/server/services/fulltext";
import * as retrieval from "@/server/services/fulltext-retrieval";
import { resetDb } from "../db-utils";
import { FakeHttpClient } from "../fake-http-client";
import { createProjectWithTeam, createTestCitation } from "../factories";

process.env.STORAGE_DIR = mkdtempSync(path.join(os.tmpdir(), "srb-autofetch-it-"));
const ORIGINAL_CONTACT_EMAIL = process.env.CONTACT_EMAIL;
process.env.CONTACT_EMAIL = "it@test.local";

const ctx = (userId: string) => ({ userId });
const PDF = Buffer.from("%PDF-1.4\n%fake pdf body for autofetch tests");

async function expectAppError(promise: Promise<unknown>, code: string) {
  try {
    await promise;
    expect.fail(`expected AppError(${code}) but call succeeded`);
  } catch (err) {
    if (!(err instanceof AppError)) throw err;
    expect(err.code).toBe(code);
  }
}

async function createStages(projectId: string) {
  const ta = await prisma.screeningStage.create({ data: { projectId, type: "TITLE_ABSTRACT" } });
  const ftStage = await prisma.screeningStage.create({ data: { projectId, type: "FULL_TEXT" } });
  return { ta, ftStage };
}

async function includeAtTa(stageId: string, citationId: string) {
  return prisma.citationStageResult.create({
    data: { stageId, citationId, outcome: "INCLUDE", resolvedVia: "CONSENSUS" },
  });
}

describe("library settings + OA auto-fetch", () => {
  beforeAll(async () => {
    await resetDb();
  });

  afterEach(() => {
    resetHttpClientForTests();
  });

  afterAll(() => {
    if (ORIGINAL_CONTACT_EMAIL === undefined) delete process.env.CONTACT_EMAIL;
    else process.env.CONTACT_EMAIL = ORIGINAL_CONTACT_EMAIL;
  });

  it("org OWNER upserts library settings (audited); plain members read but cannot write", async () => {
    const { owner, reviewer1, org } = await createProjectWithTeam();

    await expectAppError(
      orgs.updateLibrarySettings(ctx(reviewer1.id), org.id, {
        institutionName: "Sneaky Library",
      }),
      "FORBIDDEN",
    );

    const saved = await orgs.updateLibrarySettings(ctx(owner.id), org.id, {
      institutionName: "Test University Library",
      ezproxyBaseUrl: "https://login.ezproxy.test.edu/login?url=",
      openUrlBaseUrl: "https://test.edu/openurl",
    });
    expect(saved.institutionName).toBe("Test University Library");

    const event = await prisma.auditEvent.findFirstOrThrow({
      where: { action: "org.library_settings.updated", userId: owner.id },
    });
    expect(event.newValue).toMatchObject({ institutionName: "Test University Library" });

    const read = await orgs.getLibrarySettings(ctx(reviewer1.id), org.id);
    expect(read.ezproxyBaseUrl).toBe("https://login.ezproxy.test.edu/login?url=");

    // Second update overwrites and records the previous value.
    await orgs.updateLibrarySettings(ctx(owner.id), org.id, { institutionName: "Renamed" });
    const second = await prisma.auditEvent.findFirstOrThrow({
      where: { action: "org.library_settings.updated" },
      orderBy: { createdAt: "desc" },
    });
    expect(second.previousValue).toMatchObject({ institutionName: "Test University Library" });
  });

  it("full-text queue items expose library links built from the org settings", async () => {
    const { owner, org, project } = await createProjectWithTeam();
    await orgs.updateLibrarySettings(ctx(owner.id), org.id, {
      institutionName: "Queue University",
      ezproxyBaseUrl: "https://login.ezproxy.queue.edu/login?url=",
      openUrlBaseUrl: "https://queue.edu/openurl",
    });
    const { ta } = await createStages(project.id);
    const citation = await createTestCitation(project.id, { doi: "10.9999/queue1" });
    await includeAtTa(ta.id, citation.id);

    const queue = await ft.getFullTextQueue(ctx(owner.id), project.id);
    expect(queue).toHaveLength(1);
    const links = queue[0]!.libraryLinks!;
    expect(links.institutionName).toBe("Queue University");
    expect(links.proxiedDoiUrl).toContain("login.ezproxy.queue.edu");
    expect(links.openUrlLink).toContain("queue.edu/openurl?");
  });

  it("runs a full auto-fetch lifecycle: snapshot, poll-driven fetch, completion + audits", async () => {
    const { owner, reviewer1, project } = await createProjectWithTeam();
    const { ta } = await createStages(project.id);

    // c1: DOI with an OA PDF via Unpaywall. c2: PMID only, Europe PMC has nothing.
    // c3: no identifiers (ineligible). c4: already has a file (ineligible).
    const c1 = await createTestCitation(project.id, { doi: "10.1000/oa1" });
    const c2 = await createTestCitation(project.id, { pmid: "424242" });
    const c3 = await createTestCitation(project.id);
    const c4 = await createTestCitation(project.id, { doi: "10.1000/hasfile" });
    for (const c of [c1, c2, c3, c4]) await includeAtTa(ta.id, c.id);
    await ft.uploadFullText(ctx(owner.id), project.id, {
      citationId: c4.id,
      filename: "existing.pdf",
      bytes: PDF,
    });

    const fake = new FakeHttpClient()
      .on("10.1000%2Foa1", {
        json: { best_oa_location: { url_for_pdf: "https://oa.example/c1.pdf" } },
      })
      .on("oa.example/c1.pdf", { bytes: PDF, contentType: "application/pdf" })
      .on("europepmc/webservices/rest/search", { json: { resultList: { result: [] } } });
    setHttpClientForTests(fake);

    // REVIEWER cannot start a run.
    await expectAppError(retrieval.startRetrievalRun(ctx(reviewer1.id), project.id, {}), "FORBIDDEN");

    const run = await retrieval.startRetrievalRun(ctx(owner.id), project.id, {});
    expect(run.totalCount).toBe(2); // c3 (no ids) and c4 (has file) excluded
    await prisma.auditEvent.findFirstOrThrow({
      where: { action: "fulltext.autofetch.started", entityId: run.id },
    });

    // A second start while RUNNING is rejected.
    await expectAppError(retrieval.startRetrievalRun(ctx(owner.id), project.id, {}), "INVALID_STATE");

    const after = await retrieval.pollRetrievalRun(ctx(owner.id), project.id, run.id);
    expect(after.status).toBe("COMPLETED");
    expect(after.processedCount).toBe(2);
    expect(after.retrievedCount).toBe(1);

    // c1 got a stored file + link + RETRIEVED attempt; the store audited as a file upload.
    const c1Links = await prisma.citationFullTextLink.findMany({ where: { citationId: c1.id } });
    expect(c1Links).toHaveLength(1);
    const c1Attempt = await prisma.fullTextRetrievalAttempt.findFirstOrThrow({
      where: { citationId: c1.id },
    });
    expect(c1Attempt).toMatchObject({ method: "unpaywall", outcome: "RETRIEVED" });
    await prisma.auditEvent.findFirstOrThrow({
      where: { projectId: project.id, action: "fulltext.file.uploaded" },
    });

    // c2 got a NOT_RETRIEVED attempt listing what was tried.
    const c2Attempt = await prisma.fullTextRetrievalAttempt.findFirstOrThrow({
      where: { citationId: c2.id },
    });
    expect(c2Attempt.outcome).toBe("NOT_RETRIEVED");
    expect(c2Attempt.notes).toContain("europepmc");

    // Engine attempts are NOT per-row audited (run-level only).
    expect(
      await prisma.auditEvent.count({
        where: { projectId: project.id, action: "fulltext.retrieval.recorded" },
      }),
    ).toBe(0);
    await prisma.auditEvent.findFirstOrThrow({
      where: { action: "fulltext.autofetch.completed", entityId: run.id },
    });

    // Poll after completion is a no-op.
    const again = await retrieval.pollRetrievalRun(ctx(owner.id), project.id, run.id);
    expect(again.status).toBe("COMPLETED");
    expect(again.processedCount).toBe(2);

    // NOT_RETRIEVED citations are excluded from a fresh run unless includeNotRetrieved.
    await expectAppError(retrieval.startRetrievalRun(ctx(owner.id), project.id, {}), "INVALID_STATE");
    const retry = await retrieval.startRetrievalRun(ctx(owner.id), project.id, {
      includeNotRetrieved: true,
    });
    expect(retry.totalCount).toBe(1); // just c2
    await retrieval.cancelRetrievalRun(ctx(owner.id), project.id, retry.id);
  });

  it("rejects non-PDF download bodies (HTML interstitials) and stores nothing", async () => {
    const { owner, project } = await createProjectWithTeam();
    const { ta } = await createStages(project.id);
    const c = await createTestCitation(project.id, { doi: "10.1000/html1" });
    await includeAtTa(ta.id, c.id);

    const fake = new FakeHttpClient()
      .on("10.1000%2Fhtml1", {
        json: { best_oa_location: { url_for_pdf: "https://pub.example/blocked.pdf" } },
      })
      .on("pub.example/blocked.pdf", {
        bytes: Buffer.from("<html>please sign in</html>"),
        contentType: "text/html",
      })
      .on("europepmc/webservices/rest/search", { json: { resultList: { result: [] } } });
    setHttpClientForTests(fake);

    const result = await retrieval.findPdfForCitation(ctx(owner.id), project.id, c.id);
    expect(result.outcome).toBe("NOT_RETRIEVED");
    expect(result.notes).toContain("not a PDF");
    expect(await prisma.fullTextFile.count({ where: { projectId: project.id } })).toBe(0);
    const attempt = await prisma.fullTextRetrievalAttempt.findFirstOrThrow({
      where: { citationId: c.id },
    });
    expect(attempt.outcome).toBe("NOT_RETRIEVED");
  });

  it("cancel closes a running run (audited); find-pdf without identifiers is rejected", async () => {
    const { owner, project } = await createProjectWithTeam();
    const { ta } = await createStages(project.id);
    const c = await createTestCitation(project.id, { doi: "10.1000/cancelme" });
    await includeAtTa(ta.id, c.id);

    const run = await retrieval.startRetrievalRun(ctx(owner.id), project.id, {});
    const canceled = await retrieval.cancelRetrievalRun(ctx(owner.id), project.id, run.id);
    expect(canceled.status).toBe("CANCELED");
    await prisma.auditEvent.findFirstOrThrow({
      where: { action: "fulltext.autofetch.canceled", entityId: run.id },
    });
    // Poll after cancel does not process anything.
    const polled = await retrieval.pollRetrievalRun(ctx(owner.id), project.id, run.id);
    expect(polled.status).toBe("CANCELED");
    expect(polled.processedCount).toBe(0);

    const noIds = await createTestCitation(project.id);
    await includeAtTa(ta.id, noIds.id);
    await expectAppError(
      retrieval.findPdfForCitation(ctx(owner.id), project.id, noIds.id),
      "INVALID_STATE",
    );

    // Tenancy: a run id from another project is invisible.
    const other = await createProjectWithTeam();
    await expectAppError(
      retrieval.pollRetrievalRun(ctx(other.owner.id), other.project.id, run.id),
      "NOT_FOUND",
    );
  });
});
