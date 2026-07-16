// Import domain service: ImportSource CRUD + the two-step import flow
// (upload/parse → PREVIEWED batch with every source row preserved → commit → citations).
import { z } from "zod";
import type { IdentifierType, Prisma } from "@prisma/client";
import { prisma } from "@/server/db";
import { conflict, invalidState, notFound } from "@/server/errors";
import type { Ctx } from "@/server/auth/session";
import { requirePermission } from "@/server/permissions";
import * as audit from "@/server/services/audit";
import { AuditActions } from "@/server/services/audit";
import {
  normalizeDoi,
  normalizePmid,
  normalizeTitle,
} from "@/server/services/citations/normalize";
import { detectFormat, parse, type ParsedRecord } from "./parsers";

export const MAX_IMPORT_BYTES = 20 * 1024 * 1024; // 20 MB

// ---------------------------------------------------------------------------
// Schemas (exported for the route handlers)
// ---------------------------------------------------------------------------

export const createImportSourceSchema = z.object({
  name: z.string().trim().min(1).max(120),
  description: z.string().trim().max(2000).optional(),
});

export const updateImportSourceSchema = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  description: z.string().trim().max(2000).nullable().optional(),
});

export const createBatchSchema = z.object({
  filename: z.string().trim().min(1).max(255),
  sourceId: z.string().min(1),
  format: z.enum(["RIS", "BIBTEX", "CSV", "NBIB"]).optional(),
  content: z.string(),
});

// ---------------------------------------------------------------------------
// Import sources
// ---------------------------------------------------------------------------

export async function listImportSources(ctx: Ctx, projectId: string) {
  await requirePermission(ctx, projectId, "project.view");
  return prisma.importSource.findMany({
    where: { projectId },
    include: { _count: { select: { batches: true } } },
    orderBy: { createdAt: "asc" },
  });
}

export async function createImportSource(
  ctx: Ctx,
  projectId: string,
  input: z.infer<typeof createImportSourceSchema>,
) {
  await requirePermission(ctx, projectId, "import.manage");
  return prisma.$transaction(async (tx) => {
    const existing = await tx.importSource.findUnique({
      where: { projectId_name: { projectId, name: input.name } },
    });
    if (existing) throw conflict("An import source with this name already exists");
    const source = await tx.importSource.create({
      data: { projectId, name: input.name, description: input.description },
    });
    // NOTE: no IMPORT_SOURCE_* audit actions exist — PROJECT_UPDATED is the closest fit
    // for project-level import configuration changes (flagged in the build report).
    await audit.record(tx, {
      projectId,
      userId: ctx.userId,
      entityType: "ImportSource",
      entityId: source.id,
      action: AuditActions.PROJECT_UPDATED,
      newValue: { name: source.name, description: source.description },
      metadata: { operation: "import_source.created" },
    });
    return source;
  });
}

export async function updateImportSource(
  ctx: Ctx,
  projectId: string,
  sourceId: string,
  input: z.infer<typeof updateImportSourceSchema>,
) {
  await requirePermission(ctx, projectId, "import.manage");
  return prisma.$transaction(async (tx) => {
    const source = await tx.importSource.findFirst({ where: { id: sourceId, projectId } });
    if (!source) throw notFound("Import source");
    if (input.name && input.name !== source.name) {
      const clash = await tx.importSource.findUnique({
        where: { projectId_name: { projectId, name: input.name } },
      });
      if (clash) throw conflict("An import source with this name already exists");
    }
    const updated = await tx.importSource.update({
      where: { id: source.id },
      data: {
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.description !== undefined ? { description: input.description } : {}),
      },
    });
    await audit.record(tx, {
      projectId,
      userId: ctx.userId,
      entityType: "ImportSource",
      entityId: source.id,
      action: AuditActions.PROJECT_UPDATED,
      previousValue: { name: source.name, description: source.description },
      newValue: { name: updated.name, description: updated.description },
      metadata: { operation: "import_source.updated" },
    });
    return updated;
  });
}

export async function deleteImportSource(ctx: Ctx, projectId: string, sourceId: string) {
  await requirePermission(ctx, projectId, "import.manage");
  return prisma.$transaction(async (tx) => {
    const source = await tx.importSource.findFirst({
      where: { id: sourceId, projectId },
      include: { _count: { select: { batches: true } } },
    });
    if (!source) throw notFound("Import source");
    if (source._count.batches > 0) {
      throw conflict("This source has import batches and cannot be deleted");
    }
    await tx.importSource.delete({ where: { id: source.id } });
    await audit.record(tx, {
      projectId,
      userId: ctx.userId,
      entityType: "ImportSource",
      entityId: source.id,
      action: AuditActions.PROJECT_UPDATED,
      previousValue: { name: source.name, description: source.description },
      metadata: { operation: "import_source.deleted" },
    });
    return { id: source.id };
  });
}

// ---------------------------------------------------------------------------
// Import batches — step 1: parse + preview
// ---------------------------------------------------------------------------

export async function createBatch(
  ctx: Ctx,
  projectId: string,
  input: z.infer<typeof createBatchSchema>,
) {
  await requirePermission(ctx, projectId, "import.manage");

  if (Buffer.byteLength(input.content, "utf8") > MAX_IMPORT_BYTES) {
    throw invalidState("Import file exceeds the 20 MB limit");
  }

  // Body-supplied FK must belong to the path project (R9).
  const source = await prisma.importSource.findFirst({
    where: { id: input.sourceId, projectId },
  });
  if (!source) throw notFound("Import source");

  const format = input.format ?? detectFormat(input.filename, input.content);
  if (!format) {
    throw invalidState(
      "Could not detect the import format — specify one of RIS, BIBTEX, CSV, NBIB",
    );
  }

  const { records, errors } = parse(format, input.content);

  return prisma.$transaction(
    async (tx) => {
      const batch = await tx.importBatch.create({
        data: {
          projectId,
          sourceId: source.id,
          filename: input.filename,
          format,
          status: "PREVIEWED",
          totalRecords: records.length + errors.length,
          parsedRecords: records.length,
          failedRecords: errors.length,
          createdById: ctx.userId,
        },
      });

      // Every row is preserved — including unparseable ones (citationId stays null).
      const rows: Prisma.CitationSourceRecordCreateManyInput[] = [
        ...records.map((record) => {
          const { rawChunk, rowNumber, ...parsed } = record;
          return {
            batchId: batch.id,
            rowNumber,
            rawRecord: rawChunk,
            parsed: parsed as unknown as Prisma.InputJsonValue,
          };
        }),
        ...errors.map((error) => ({
          batchId: batch.id,
          rowNumber: error.rowNumber,
          rawRecord: error.rawChunk,
          parseErrors: [{ message: error.message }] as unknown as Prisma.InputJsonValue,
        })),
      ].sort((a, b) => a.rowNumber - b.rowNumber);
      if (rows.length > 0) await tx.citationSourceRecord.createMany({ data: rows });

      await audit.record(tx, {
        projectId,
        userId: ctx.userId,
        entityType: "ImportBatch",
        entityId: batch.id,
        action: AuditActions.IMPORT_BATCH_CREATED,
        metadata: {
          filename: input.filename,
          format,
          sourceId: source.id,
          sourceName: source.name,
          totalRecords: batch.totalRecords,
          parsedRecords: batch.parsedRecords,
          failedRecords: batch.failedRecords,
        },
      });

      return { ...batch, source };
    },
    { timeout: 30_000 },
  );
}

export async function listBatches(ctx: Ctx, projectId: string) {
  await requirePermission(ctx, projectId, "project.view");
  return prisma.importBatch.findMany({
    where: { projectId },
    include: {
      source: true,
      createdBy: { select: { id: true, name: true, email: true } },
    },
    orderBy: { createdAt: "desc" },
  });
}

export async function getBatch(ctx: Ctx, projectId: string, batchId: string) {
  await requirePermission(ctx, projectId, "project.view");
  const batch = await prisma.importBatch.findFirst({
    where: { id: batchId, projectId }, // tenant-scoped by-id load (R9)
    include: {
      source: true,
      createdBy: { select: { id: true, name: true, email: true } },
    },
  });
  if (!batch) throw notFound("Import batch");
  const rows = await prisma.citationSourceRecord.findMany({
    where: { batchId: batch.id },
    orderBy: { rowNumber: "asc" },
    select: {
      id: true,
      rowNumber: true,
      rawRecord: true,
      parsed: true,
      parseErrors: true,
      citationId: true,
    },
  });
  return { ...batch, rows };
}

// Delete an import batch and roll back citations created only by that batch. A committed
// import can be removed only while its citations are still untouched; downstream reviewer
// work is never cascade-deleted. Citations that also have a source record from another batch
// are retained and only this batch's provenance row is removed.
export async function deleteBatch(ctx: Ctx, projectId: string, batchId: string) {
  await requirePermission(ctx, projectId, "import.manage");

  return prisma.$transaction(
    async (tx) => {
      // Serialize against commitBatch so a batch cannot be committed while it is deleted.
      const locked = await tx.$queryRaw<{ id: string }[]>`
        SELECT "id"
        FROM "ImportBatch"
        WHERE "id" = ${batchId} AND "projectId" = ${projectId}
        FOR UPDATE
      `;
      if (locked.length === 0) throw notFound("Import batch");

      const batch = await tx.importBatch.findUniqueOrThrow({
        where: { id: batchId },
        include: {
          sourceRecords: { select: { citationId: true } },
        },
      });

      const linkedCitationIds = [
        ...new Set(
          batch.sourceRecords
            .map((row) => row.citationId)
            .filter((id): id is string => id !== null),
        ),
      ];

      const otherSourceRows =
        linkedCitationIds.length === 0
          ? []
          : await tx.citationSourceRecord.findMany({
              where: {
                citationId: { in: linkedCitationIds },
                batchId: { not: batch.id },
              },
              select: { citationId: true },
              distinct: ["citationId"],
            });
      const retainedCitationIds = new Set(
        otherSourceRows
          .map((row) => row.citationId)
          .filter((id): id is string => id !== null),
      );
      const citationIdsToDelete = linkedCitationIds.filter((id) => !retainedCitationIds.has(id));

      if (citationIdsToDelete.length > 0) {
        const activeAiRun = await tx.aiScreeningRun.findFirst({
          where: { projectId, status: { in: ["PENDING", "SUBMITTED"] } },
          select: { id: true },
        });
        if (activeAiRun) {
          throw invalidState(
            "An AI screening batch is still running. Wait for it to finish or cancel it before deleting an import.",
          );
        }

        const blockedCitation = await tx.citation.findFirst({
          where: {
            projectId,
            id: { in: citationIdsToDelete },
            OR: [
              { status: "DUPLICATE" },
              { duplicateOfId: { not: null } },
              { duplicates: { some: {} } },
              { assignments: { some: {} } },
              { decisions: { some: {} } },
              { conflicts: { some: {} } },
              { stageResults: { some: {} } },
              { studyLinks: { some: {} } },
              { fullTextLinks: { some: {} } },
              { retrievalAttempts: { some: {} } },
              { extractionForms: { some: {} } },
              { aiSuggestions: { some: {} } },
              { dedupCandidatesAsA: { some: { status: { not: "SUGGESTED" } } } },
              { dedupCandidatesAsB: { some: { status: { not: "SUGGESTED" } } } },
            ],
          },
          select: { title: true },
        });
        if (blockedCitation) {
          throw invalidState(
            `This import cannot be deleted because “${blockedCitation.title}” has downstream review work. Remove or reset that work first.`,
          );
        }

        // Unreviewed dedup suggestions are derived data and can be regenerated after reimport.
        const suggestedCandidates = await tx.deduplicationCandidate.findMany({
          where: {
            status: "SUGGESTED",
            OR: [
              { citationAId: { in: citationIdsToDelete } },
              { citationBId: { in: citationIdsToDelete } },
            ],
          },
          select: { id: true, groupId: true },
        });
        const candidateIds = suggestedCandidates.map((candidate) => candidate.id);
        const groupIds = [
          ...new Set(
            suggestedCandidates
              .map((candidate) => candidate.groupId)
              .filter((id): id is string => id !== null),
          ),
        ];
        if (candidateIds.length > 0) {
          await tx.deduplicationCandidate.deleteMany({ where: { id: { in: candidateIds } } });
        }

        await tx.citationIdentifier.deleteMany({
          where: { citationId: { in: citationIdsToDelete } },
        });
        await tx.citationSourceRecord.deleteMany({ where: { batchId: batch.id } });
        await tx.citation.deleteMany({ where: { id: { in: citationIdsToDelete } } });

        if (groupIds.length > 0) {
          await tx.deduplicationGroup.deleteMany({
            where: { id: { in: groupIds }, candidates: { none: {} } },
          });
        }
      } else {
        await tx.citationSourceRecord.deleteMany({ where: { batchId: batch.id } });
      }

      await tx.importBatch.delete({ where: { id: batch.id } });
      const result = {
        id: batch.id,
        citationsDeleted: citationIdsToDelete.length,
        citationsRetained: retainedCitationIds.size,
      };
      await audit.record(tx, {
        projectId,
        userId: ctx.userId,
        entityType: "ImportBatch",
        entityId: batch.id,
        action: AuditActions.IMPORT_BATCH_DELETED,
        previousValue: {
          filename: batch.filename,
          format: batch.format,
          status: batch.status,
          sourceId: batch.sourceId,
          totalRecords: batch.totalRecords,
          parsedRecords: batch.parsedRecords,
          failedRecords: batch.failedRecords,
        },
        metadata: result,
      });
      return result;
    },
    { timeout: 60_000 },
  );
}

// ---------------------------------------------------------------------------
// Import batches — step 2: commit
// ---------------------------------------------------------------------------

export async function commitBatch(ctx: Ctx, projectId: string, batchId: string) {
  await requirePermission(ctx, projectId, "import.manage");

  return prisma.$transaction(
    async (tx) => {
      const batch = await tx.importBatch.findFirst({ where: { id: batchId, projectId } });
      if (!batch) throw notFound("Import batch");

      // Idempotency guard: only one caller can move PREVIEWED → COMMITTED.
      const claimed = await tx.importBatch.updateMany({
        where: { id: batch.id, status: "PREVIEWED" },
        data: { status: "COMMITTED", committedAt: new Date() },
      });
      if (claimed.count === 0) {
        throw invalidState(`Import batch is ${batch.status} — only PREVIEWED batches can be committed`);
      }

      const sourceRecords = await tx.citationSourceRecord.findMany({
        where: { batchId: batch.id },
        orderBy: { rowNumber: "asc" },
      });

      let citationsCreated = 0;
      for (const row of sourceRecords) {
        if (row.parsed === null || row.citationId !== null) continue;
        const record = row.parsed as unknown as Omit<ParsedRecord, "rawChunk" | "rowNumber">;
        if (!record.title) continue; // defensive — parsers guarantee a title

        const doi = normalizeDoi(record.doi ?? null);
        const pmid = normalizePmid(record.pmid ?? null);
        const citation = await tx.citation.create({
          data: {
            projectId,
            title: record.title,
            normalizedTitle: normalizeTitle(record.title),
            authors: (record.authors ?? []) as unknown as Prisma.InputJsonValue,
            year: record.year ?? null,
            journal: record.journal ?? null,
            volume: record.volume ?? null,
            issue: record.issue ?? null,
            pages: record.pages ?? null,
            abstract: record.abstract ?? null,
            doi,
            pmid,
            url: record.url ?? null,
            language: record.language ?? null,
          },
        });

        const identifiers: { citationId: string; type: IdentifierType; value: string }[] = [];
        if (doi) identifiers.push({ citationId: citation.id, type: "DOI", value: doi });
        if (pmid) identifiers.push({ citationId: citation.id, type: "PMID", value: pmid });
        if (record.url) identifiers.push({ citationId: citation.id, type: "URL", value: record.url });
        if (identifiers.length > 0) {
          await tx.citationIdentifier.createMany({ data: identifiers, skipDuplicates: true });
        }

        await tx.citationSourceRecord.update({
          where: { id: row.id },
          data: { citationId: citation.id },
        });
        citationsCreated += 1;
      }

      await audit.record(tx, {
        projectId,
        userId: ctx.userId,
        entityType: "ImportBatch",
        entityId: batch.id,
        action: AuditActions.IMPORT_BATCH_COMMITTED,
        metadata: {
          citationsCreated,
          totalRecords: batch.totalRecords,
          parsedRecords: batch.parsedRecords,
          failedRecords: batch.failedRecords,
        },
      });

      const committed = await tx.importBatch.findUniqueOrThrow({
        where: { id: batch.id },
        include: { source: true },
      });
      return { ...committed, citationsCreated };
    },
    { timeout: 60_000 },
  );
}
