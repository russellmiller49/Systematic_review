// OA auto-fetch runs over the full-text queue. No background worker exists (docs/01) —
// the run advances only while a client polls: each poll claims a small chunk of the
// citation snapshot under a row lock, fetches OUTSIDE any transaction, then records
// progress. Concurrent polls claim disjoint chunks; abandoned claims are recovered after
// a staleness window. Run-level audit only (attempt rows are unaudited machine output).

import { z } from "zod";
import type { FullTextRetrievalRun } from "@prisma/client";
import { prisma } from "@/server/db";
import { invalidState, notFound } from "@/server/errors";
import type { Ctx } from "@/server/auth/session";
import { requirePermission } from "@/server/permissions";
import * as audit from "@/server/services/audit";
import { AuditActions } from "@/server/services/audit";
import { attemptAutoFetch, type AutoFetchCitation, type AutoFetchResult } from "./engine";

export const MAX_RUN_CITATIONS = 500;
const CHUNK_PER_POLL = 3;
const POLL_SOFT_BUDGET_MS = 25_000;
const STALE_CLAIM_MS = 2 * 60_000; // a claim older than this with no progress is re-claimable
const DELAY_BETWEEN_MS = 300; // politeness pause between citations

export const startRetrievalRunSchema = z.object({
  // Default false: citations whose latest attempt is NOT_RETRIEVED are skipped (someone
  // already tried); true retries them too.
  includeNotRetrieved: z.boolean().optional(),
});

// citationIds can hold hundreds of ids — never sent to clients.
export type RetrievalRunView = Omit<FullTextRetrievalRun, "citationIds">;

function runView(run: FullTextRetrievalRun): RetrievalRunView {
  const { citationIds: _citationIds, ...view } = run;
  return view;
}

function idsOf(run: FullTextRetrievalRun): string[] {
  return Array.isArray(run.citationIds)
    ? (run.citationIds as unknown[]).filter((id): id is string => typeof id === "string")
    : [];
}

// Eligibility = the T/A-INCLUDE queue population (same shape as getFullTextQueue) with no
// attached file and at least one usable identifier; minus already-tried NOT_RETRIEVED
// citations unless includeNotRetrieved.
async function computeEligibleCitationIds(
  projectId: string,
  includeNotRetrieved: boolean,
): Promise<string[]> {
  const taStage = await prisma.screeningStage.findFirst({
    where: { projectId, type: "TITLE_ABSTRACT" },
  });
  if (!taStage) return [];
  const citations = await prisma.citation.findMany({
    where: {
      projectId,
      status: "ACTIVE",
      stageResults: { some: { stageId: taStage.id, outcome: "INCLUDE" } },
      fullTextLinks: { none: {} },
      OR: [{ doi: { not: null } }, { pmid: { not: null } }],
    },
    select: {
      id: true,
      retrievalAttempts: {
        orderBy: [{ attemptedAt: "desc" }, { id: "desc" }],
        take: 1,
        select: { outcome: true },
      },
    },
    orderBy: { createdAt: "asc" },
  });
  return citations
    .filter(
      (c) => includeNotRetrieved || c.retrievalAttempts[0]?.outcome !== "NOT_RETRIEVED",
    )
    .map((c) => c.id)
    .slice(0, MAX_RUN_CITATIONS);
}

export async function startRetrievalRun(
  ctx: Ctx,
  projectId: string,
  input: z.infer<typeof startRetrievalRunSchema>,
): Promise<RetrievalRunView> {
  await requirePermission(ctx, projectId, "fulltext.manage");

  const inFlight = await prisma.fullTextRetrievalRun.findFirst({
    where: { projectId, status: "RUNNING" },
  });
  if (inFlight) throw invalidState("A PDF auto-fetch run is already in progress");

  const includeNotRetrieved = input.includeNotRetrieved ?? false;
  const citationIds = await computeEligibleCitationIds(projectId, includeNotRetrieved);
  if (citationIds.length === 0) {
    throw invalidState(
      includeNotRetrieved
        ? "No eligible citations — every T/A-included citation either has a PDF already or has no DOI/PMID"
        : "No eligible citations — check “retry not-retrieved” to re-try citations that already failed",
    );
  }

  const run = await prisma.$transaction(async (tx) => {
    const created = await tx.fullTextRetrievalRun.create({
      data: {
        projectId,
        status: "RUNNING",
        citationIds,
        totalCount: citationIds.length,
        requestedById: ctx.userId,
      },
    });
    await audit.record(tx, {
      projectId,
      userId: ctx.userId,
      entityType: "FullTextRetrievalRun",
      entityId: created.id,
      action: AuditActions.FULLTEXT_AUTOFETCH_STARTED,
      metadata: { totalCount: citationIds.length, includeNotRetrieved },
    });
    return created;
  });
  return runView(run);
}

// The worker heartbeat. Idempotent under concurrent polls: chunk claims happen under a
// row lock, so two polls never process the same citation (except after the stale-claim
// window, where re-processing is harmless — attemptAutoFetch skips citations that
// already have a file).
export async function pollRetrievalRun(
  ctx: Ctx,
  projectId: string,
  runId: string,
): Promise<RetrievalRunView> {
  await requirePermission(ctx, projectId, "fulltext.manage");
  const run = await prisma.fullTextRetrievalRun.findFirst({ where: { id: runId, projectId } });
  if (!run) throw notFound("Auto-fetch run");
  if (run.status !== "RUNNING") return runView(run);

  // tx#1 — claim a chunk.
  const claim = await prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM "FullTextRetrievalRun" WHERE id = ${run.id} FOR UPDATE`;
    const fresh = await tx.fullTextRetrievalRun.findUnique({ where: { id: run.id } });
    if (!fresh || fresh.status !== "RUNNING") return { fresh: fresh ?? run, sliceIds: [] };

    let claimedCount = fresh.claimedCount;
    const stale =
      claimedCount > fresh.processedCount &&
      Date.now() - fresh.updatedAt.getTime() > STALE_CLAIM_MS;
    if (stale) claimedCount = fresh.processedCount; // reclaim abandoned work

    const ids = idsOf(fresh);
    const sliceIds = ids.slice(claimedCount, claimedCount + CHUNK_PER_POLL);
    if (sliceIds.length === 0) return { fresh, sliceIds };

    const updated = await tx.fullTextRetrievalRun.update({
      where: { id: run.id },
      data: { claimedCount: claimedCount + sliceIds.length },
    });
    return { fresh: updated, sliceIds };
  });
  if (claim.sliceIds.length === 0) return runView(claim.fresh);
  const claimEnd = claim.fresh.claimedCount;

  // Network I/O outside any transaction, bounded by a soft time budget.
  const startedAt = Date.now();
  let processed = 0;
  let retrieved = 0;
  try {
    for (const citationId of claim.sliceIds) {
      if (processed > 0 && Date.now() - startedAt > POLL_SOFT_BUDGET_MS) break;
      const citation = await prisma.citation.findFirst({
        where: { id: citationId, projectId },
        select: {
          id: true,
          status: true,
          doi: true,
          pmid: true,
          _count: { select: { fullTextLinks: true } },
        },
      });
      if (citation && citation.status === "ACTIVE") {
        const target: AutoFetchCitation = {
          id: citation.id,
          doi: citation.doi,
          pmid: citation.pmid,
          hasFile: citation._count.fullTextLinks > 0,
        };
        const result: AutoFetchResult = await attemptAutoFetch(ctx, projectId, target);
        if (result.outcome === "RETRIEVED") retrieved += 1;
        await new Promise((resolve) => setTimeout(resolve, DELAY_BETWEEN_MS));
      }
      processed += 1;
    }
  } catch (error) {
    // Unexpected failure (storage/DB) — close the run so it doesn't hang RUNNING forever.
    const message = (error instanceof Error ? error.message : String(error)).slice(0, 2000);
    const failed = await prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "FullTextRetrievalRun" WHERE id = ${run.id} FOR UPDATE`;
      const fresh = await tx.fullTextRetrievalRun.findUnique({ where: { id: run.id } });
      if (!fresh || fresh.status !== "RUNNING") return fresh ?? run;
      const updated = await tx.fullTextRetrievalRun.update({
        where: { id: run.id },
        data: {
          status: "FAILED",
          error: message,
          processedCount: fresh.processedCount + processed,
          retrievedCount: fresh.retrievedCount + retrieved,
          completedAt: new Date(),
        },
      });
      await audit.record(tx, {
        projectId,
        userId: ctx.userId,
        entityType: "FullTextRetrievalRun",
        entityId: run.id,
        action: AuditActions.FULLTEXT_AUTOFETCH_FAILED,
        metadata: { error: message },
      });
      return updated;
    });
    return runView(failed);
  }

  // tx#2 — record progress; give back any unprocessed tail of MY claim (only when no
  // later claim exists); finalize when everything is processed.
  const done = await prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM "FullTextRetrievalRun" WHERE id = ${run.id} FOR UPDATE`;
    const fresh = await tx.fullTextRetrievalRun.findUnique({ where: { id: run.id } });
    if (!fresh || fresh.status !== "RUNNING") return fresh ?? run; // canceled mid-flight

    const unprocessed = claim.sliceIds.length - processed;
    const giveBack = unprocessed > 0 && fresh.claimedCount === claimEnd;
    const processedCount = fresh.processedCount + processed;
    const complete = processedCount >= fresh.totalCount;

    const updated = await tx.fullTextRetrievalRun.update({
      where: { id: run.id },
      data: {
        processedCount,
        retrievedCount: fresh.retrievedCount + retrieved,
        ...(giveBack ? { claimedCount: claimEnd - unprocessed } : {}),
        ...(complete ? { status: "COMPLETED", completedAt: new Date() } : {}),
      },
    });
    if (complete) {
      await audit.record(tx, {
        projectId,
        userId: ctx.userId,
        entityType: "FullTextRetrievalRun",
        entityId: run.id,
        action: AuditActions.FULLTEXT_AUTOFETCH_COMPLETED,
        metadata: {
          totalCount: updated.totalCount,
          retrievedCount: updated.retrievedCount,
          notRetrievedCount: updated.totalCount - updated.retrievedCount,
        },
      });
    }
    return updated;
  });
  return runView(done);
}

export async function cancelRetrievalRun(
  ctx: Ctx,
  projectId: string,
  runId: string,
): Promise<RetrievalRunView> {
  await requirePermission(ctx, projectId, "fulltext.manage");
  const run = await prisma.fullTextRetrievalRun.findFirst({ where: { id: runId, projectId } });
  if (!run) throw notFound("Auto-fetch run");
  if (run.status !== "RUNNING") throw invalidState("Only running auto-fetch runs can be canceled");

  const updated = await prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM "FullTextRetrievalRun" WHERE id = ${run.id} FOR UPDATE`;
    const fresh = await tx.fullTextRetrievalRun.findUnique({ where: { id: run.id } });
    if (!fresh || fresh.status !== "RUNNING") return fresh ?? run;
    const canceled = await tx.fullTextRetrievalRun.update({
      where: { id: run.id },
      data: { status: "CANCELED", completedAt: new Date() },
    });
    await audit.record(tx, {
      projectId,
      userId: ctx.userId,
      entityType: "FullTextRetrievalRun",
      entityId: run.id,
      action: AuditActions.FULLTEXT_AUTOFETCH_CANCELED,
    });
    return canceled;
  });
  return runView(updated);
}

export async function listRetrievalRuns(
  ctx: Ctx,
  projectId: string,
): Promise<{
  runs: (RetrievalRunView & { requestedBy: { id: string; name: string } })[];
  eligible: number;
}> {
  await requirePermission(ctx, projectId, "fulltext.manage");
  const [runs, eligibleIds] = await Promise.all([
    prisma.fullTextRetrievalRun.findMany({
      where: { projectId },
      orderBy: { createdAt: "desc" },
      take: 10,
      include: { requestedBy: { select: { id: true, name: true } } },
    }),
    computeEligibleCitationIds(projectId, false),
  ]);
  return {
    runs: runs.map((run) => ({ ...runView(run), requestedBy: run.requestedBy })),
    eligible: eligibleIds.length,
  };
}

// Single-citation manual "Find PDF" (bounded: two sources, one download each).
export async function findPdfForCitation(
  ctx: Ctx,
  projectId: string,
  citationId: string,
): Promise<AutoFetchResult> {
  await requirePermission(ctx, projectId, "fulltext.manage");
  const citation = await prisma.citation.findFirst({
    where: { id: citationId, projectId, status: "ACTIVE" },
    select: { id: true, doi: true, pmid: true, _count: { select: { fullTextLinks: true } } },
  });
  if (!citation) throw notFound("Citation");
  if (!citation.doi && !citation.pmid) {
    throw invalidState("This citation has no DOI or PMID to search by");
  }
  return attemptAutoFetch(ctx, projectId, {
    id: citation.id,
    doi: citation.doi,
    pmid: citation.pmid,
    hasFile: citation._count.fullTextLinks > 0,
  });
}
