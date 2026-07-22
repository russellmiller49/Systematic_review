// Full-text retrieval domain: PDF upload/link/serving, retrieval attempts, FT queue.
// Follows the exemplar service shape (src/server/services/orgs): zod schemas exported for
// routes, ctx first, requirePermission first, mutations + audit inside one transaction,
// by-id loads tenant-scoped (R9), upload policy per R13 (docs/09).

import { createHash, randomBytes } from "node:crypto";
import { z } from "zod";
import type { RetrievalOutcome } from "@prisma/client";
import { prisma } from "@/server/db";
import { conflict, invalidState, notFound, validationError } from "@/server/errors";
import type { Ctx } from "@/server/auth/session";
import { requirePermission } from "@/server/permissions";
import { can } from "@/server/permissions/matrix";
import * as audit from "@/server/services/audit";
import { AuditActions } from "@/server/services/audit";
import { getStorage } from "@/server/storage";
import { buildLibraryLinks } from "@/lib/library-links";

export const MAX_PDF_BYTES = 50 * 1024 * 1024; // R13: 50 MB cap
const PDF_MAGIC = "%PDF-";

// ---------------------------------------------------------------------------
// Schemas (multipart file itself is handled by the route; these cover the fields)
// ---------------------------------------------------------------------------

export const uploadFullTextFieldsSchema = z.object({
  citationId: z.string().min(1),
  label: z.string().trim().min(1).max(200).optional(),
});

export const linkFileSchema = z.object({
  citationId: z.string().min(1),
  label: z.string().trim().min(1).max(200).optional(),
});

export const recordRetrievalAttemptSchema = z.object({
  method: z.string().trim().min(2).max(200), // publisher site, library, ILL, author email, ...
  outcome: z.enum(["PENDING", "RETRIEVED", "NOT_RETRIEVED"]), // "mark unavailable" = NOT_RETRIEVED
  notes: z.string().trim().max(2000).optional(),
});

export const queueFilterSchema = z.object({
  retrieval: z.enum(["pending", "retrieved", "not_retrieved"]).optional(),
});

export interface UploadFullTextInput {
  citationId: string;
  filename: string;
  bytes: Buffer;
  label?: string;
}

// R13: serving header filename sanitized to [a-zA-Z0-9._-].
export function sanitizeFilename(name: string): string {
  const cleaned = name.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 200);
  return /[a-zA-Z0-9]/.test(cleaned) ? cleaned : "file.pdf";
}

// ---------------------------------------------------------------------------
// Upload / link
// ---------------------------------------------------------------------------

async function loadActiveCitation(projectId: string, citationId: string) {
  const citation = await prisma.citation.findFirst({
    where: { id: citationId, projectId, status: "ACTIVE" },
  });
  if (!citation) throw notFound("Citation");
  return citation;
}

export async function uploadFullText(ctx: Ctx, projectId: string, input: UploadFullTextInput) {
  await requirePermission(ctx, projectId, "fulltext.manage");

  if (input.bytes.length > MAX_PDF_BYTES) {
    throw invalidState("File exceeds the 50 MB upload limit");
  }
  if (input.bytes.subarray(0, PDF_MAGIC.length).toString("latin1") !== PDF_MAGIC) {
    throw validationError("Only PDF files are accepted");
  }

  const citation = await loadActiveCitation(projectId, input.citationId);
  const sha256 = createHash("sha256").update(input.bytes).digest("hex");
  const filename = input.filename.trim() || "upload.pdf";

  // Same bytes already stored in this project → reuse the object, just add the link.
  const existing = await prisma.fullTextFile.findFirst({ where: { projectId, sha256 } });
  if (existing) {
    return prisma.$transaction(async (tx) => {
      const existingLink = await tx.citationFullTextLink.findUnique({
        where: { citationId_fileId: { citationId: citation.id, fileId: existing.id } },
      });
      if (existingLink) {
        return { file: existing, link: existingLink, reused: true, linkCreated: false };
      }
      const link = await tx.citationFullTextLink.create({
        data: { citationId: citation.id, fileId: existing.id, label: input.label ?? null },
      });
      await audit.record(tx, {
        projectId,
        userId: ctx.userId,
        entityType: "CitationFullTextLink",
        entityId: link.id,
        action: AuditActions.FULLTEXT_FILE_LINKED,
        newValue: { fileId: existing.id, citationId: citation.id, label: link.label },
        metadata: { reused: true, sha256 },
      });
      return { file: existing, link, reused: true, linkCreated: true };
    });
  }

  // New object: write to storage BEFORE the tx (a dangling storage object is recoverable;
  // a DB row pointing at missing bytes is not). Best-effort cleanup if the tx fails.
  const storage = getStorage();
  const storageKey = `${projectId}/${randomBytes(16).toString("hex")}.pdf`;
  await storage.put(storageKey, input.bytes);
  try {
    return await prisma.$transaction(async (tx) => {
      const file = await tx.fullTextFile.create({
        data: {
          projectId,
          storageKey,
          filename,
          contentType: "application/pdf", // R13: server-determined, never the client's
          sizeBytes: input.bytes.length,
          sha256,
          uploadedById: ctx.userId,
        },
      });
      const link = await tx.citationFullTextLink.create({
        data: { citationId: citation.id, fileId: file.id, label: input.label ?? null },
      });
      await audit.record(tx, {
        projectId,
        userId: ctx.userId,
        entityType: "FullTextFile",
        entityId: file.id,
        action: AuditActions.FULLTEXT_FILE_UPLOADED,
        newValue: { filename, sizeBytes: file.sizeBytes, sha256, citationId: citation.id },
      });
      return { file, link, reused: false, linkCreated: true };
    });
  } catch (err) {
    await storage.delete(storageKey).catch(() => undefined);
    throw err;
  }
}

export async function linkFileToCitation(
  ctx: Ctx,
  projectId: string,
  fileId: string,
  input: z.infer<typeof linkFileSchema>,
) {
  await requirePermission(ctx, projectId, "fulltext.manage");
  const file = await prisma.fullTextFile.findFirst({ where: { id: fileId, projectId } });
  if (!file) throw notFound("File");
  const citation = await loadActiveCitation(projectId, input.citationId);
  return prisma.$transaction(async (tx) => {
    const existing = await tx.citationFullTextLink.findUnique({
      where: { citationId_fileId: { citationId: citation.id, fileId: file.id } },
    });
    if (existing) throw conflict("This file is already linked to that citation");
    const link = await tx.citationFullTextLink.create({
      data: { citationId: citation.id, fileId: file.id, label: input.label ?? null },
    });
    await audit.record(tx, {
      projectId,
      userId: ctx.userId,
      entityType: "CitationFullTextLink",
      entityId: link.id,
      action: AuditActions.FULLTEXT_FILE_LINKED,
      newValue: { fileId: file.id, citationId: citation.id, label: link.label },
    });
    return link;
  });
}

// ---------------------------------------------------------------------------
// Serving
// ---------------------------------------------------------------------------

// No project in the path — the file row itself is the tenancy anchor: load by id, then
// require membership in the file's project (R13). 404 both for unknown ids and for
// storage objects that have gone missing.
export async function getFileForServing(ctx: Ctx, fileId: string) {
  const file = await prisma.fullTextFile.findUnique({ where: { id: fileId } });
  if (!file) throw notFound("File");
  await requirePermission(ctx, file.projectId, "project.view");
  const storage = getStorage();
  if (!(await storage.exists(file.storageKey))) throw notFound("File");
  const bytes = await storage.get(file.storageKey);
  return { file, bytes };
}

// ---------------------------------------------------------------------------
// Retrieval attempts
// ---------------------------------------------------------------------------

export async function recordRetrievalAttempt(
  ctx: Ctx,
  projectId: string,
  citationId: string,
  input: z.infer<typeof recordRetrievalAttemptSchema>,
) {
  await requirePermission(ctx, projectId, "fulltext.manage");
  const citation = await loadActiveCitation(projectId, citationId);
  return prisma.$transaction(async (tx) => {
    const attempt = await tx.fullTextRetrievalAttempt.create({
      data: {
        citationId: citation.id,
        method: input.method,
        outcome: input.outcome,
        notes: input.notes ?? null,
        recordedById: ctx.userId,
      },
    });
    await audit.record(tx, {
      projectId,
      userId: ctx.userId,
      entityType: "FullTextRetrievalAttempt",
      entityId: attempt.id,
      action: AuditActions.FULLTEXT_RETRIEVAL_RECORDED,
      newValue: { citationId: citation.id, method: attempt.method, outcome: attempt.outcome },
    });
    return attempt;
  });
}

export async function listRetrievalAttempts(ctx: Ctx, projectId: string, citationId: string) {
  await requirePermission(ctx, projectId, "project.view");
  const citation = await prisma.citation.findFirst({ where: { id: citationId, projectId } });
  if (!citation) throw notFound("Citation");
  return prisma.fullTextRetrievalAttempt.findMany({
    where: { citationId: citation.id },
    include: { recordedBy: { select: { id: true, name: true } } },
    orderBy: [{ attemptedAt: "desc" }, { id: "desc" }],
  });
}

// ---------------------------------------------------------------------------
// Full-text queue
// ---------------------------------------------------------------------------

const FILTER_TO_STATUS: Record<string, RetrievalOutcome> = {
  pending: "PENDING",
  retrieved: "RETRIEVED",
  not_retrieved: "NOT_RETRIEVED",
};

// ACTIVE citations with an INCLUDE result at TITLE_ABSTRACT (R3: eligibility for full text).
// Exposes files + retrieval state + FT stage result + a COUNT of FT decisions only —
// never decision content (screening blinding).
export async function getFullTextQueue(
  ctx: Ctx,
  projectId: string,
  filter: z.infer<typeof queueFilterSchema> = {},
) {
  const member = await requirePermission(ctx, projectId, "project.view");

  const taStage = await prisma.screeningStage.findFirst({
    where: { projectId, type: "TITLE_ABSTRACT" },
  });
  if (!taStage) return [];

  // Institutional library links: one settings lookup for the whole queue.
  const project = await prisma.project.findUniqueOrThrow({
    where: { id: projectId },
    select: { orgId: true },
  });
  const librarySettings = await prisma.organizationLibrarySettings.findUnique({
    where: { orgId: project.orgId },
  });
  const ftStage = await prisma.screeningStage.findFirst({
    where: { projectId, type: "FULL_TEXT" },
  });
  const ftStageId = ftStage?.id ?? "__no_full_text_stage__";
  const assignedWorkOnly =
    can(member.roles, "screening.decide") && !can(member.roles, "fulltext.manage");

  const citations = await prisma.citation.findMany({
    where: {
      projectId,
      status: "ACTIVE",
      stageResults: { some: { stageId: taStage.id, outcome: "INCLUDE" } },
      ...(assignedWorkOnly
        ? {
            assignments: {
              some: {
                stageId: ftStageId,
                reviewerId: ctx.userId,
                status: { not: "VOIDED" as const },
              },
            },
          }
        : {}),
    },
    include: {
      fullTextLinks: {
        include: { file: { select: { id: true, filename: true } } },
        orderBy: { createdAt: "asc" },
      },
      retrievalAttempts: {
        orderBy: [{ attemptedAt: "desc" }, { id: "desc" }],
        take: 1,
        include: { recordedBy: { select: { id: true, name: true } } },
      },
      stageResults: { where: { stageId: ftStageId } },
      assignments: {
        where: { stageId: ftStageId, reviewerId: ctx.userId, status: { not: "VOIDED" } },
        select: { status: true },
        take: 1,
      },
      _count: { select: { decisions: { where: { stageId: ftStageId } } } },
    },
    orderBy: { createdAt: "asc" },
  });

  const items = citations.map((c) => {
    const files = c.fullTextLinks.map((l) => ({
      id: l.file.id,
      filename: l.file.filename,
      label: l.label,
    }));
    const latest = c.retrievalAttempts[0] ?? null;

    let retrievalStatus: RetrievalOutcome;
    if (files.length > 0 || latest?.outcome === "RETRIEVED") retrievalStatus = "RETRIEVED";
    else if (latest?.outcome === "NOT_RETRIEVED") retrievalStatus = "NOT_RETRIEVED";
    else retrievalStatus = "PENDING";

    const ftResult = c.stageResults[0] ?? null;

    return {
      citation: {
        id: c.id,
        title: c.title,
        authors: c.authors,
        year: c.year,
        journal: c.journal,
        volume: c.volume,
        issue: c.issue,
        pages: c.pages,
        abstract: c.abstract,
        doi: c.doi,
        pmid: c.pmid,
      },
      files,
      latestRetrievalAttempt: latest
        ? {
            id: latest.id,
            method: latest.method,
            outcome: latest.outcome,
            notes: latest.notes,
            attemptedAt: latest.attemptedAt,
            recordedBy: latest.recordedBy,
          }
        : null,
      retrievalStatus,
      fullTextResult: ftResult
        ? { outcome: ftResult.outcome, resolvedVia: ftResult.resolvedVia, resolvedAt: ftResult.resolvedAt }
        : null,
      fullTextDecisionCount: c._count.decisions,
      myAssignmentStatus: c.assignments[0]?.status ?? null,
      libraryLinks: librarySettings
        ? buildLibraryLinks(
            {
              title: c.title,
              authors: c.authors,
              year: c.year,
              journal: c.journal,
              volume: c.volume,
              issue: c.issue,
              pages: c.pages,
              doi: c.doi,
              pmid: c.pmid,
            },
            librarySettings,
          )
        : null,
    };
  });

  const wanted = filter.retrieval ? FILTER_TO_STATUS[filter.retrieval] : undefined;
  return wanted ? items.filter((i) => i.retrievalStatus === wanted) : items;
}
