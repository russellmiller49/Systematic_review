// Import domain service: ImportSource CRUD + the two-step import flow
// (upload/parse → PREVIEWED batch with every source row preserved → commit → citations).
import { z } from "zod";
import type { IdentifierType, Prisma } from "@prisma/client";
import { prisma, type Tx } from "@/server/db";
import { conflict, forbidden, invalidState, notFound } from "@/server/errors";
import type { Ctx } from "@/server/auth/session";
import { requirePermission } from "@/server/permissions";
import * as audit from "@/server/services/audit";
import { AuditActions } from "@/server/services/audit";
import { undoMergeInTransaction } from "@/server/services/dedup";
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

export const ownerDeleteBatchSchema = z.object({
  confirmation: z.string().trim().min(1).max(255),
  reason: z.string().trim().min(3).max(2000),
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

type DeleteBatchOptions = {
  deleteScreeningHistory: boolean;
  confirmation?: string;
  reason?: string;
};

export type OwnerRollbackBlocker = {
  kind:
    | "ACTIVE_AI_RUN"
    | "STUDY_LINK"
    | "FULL_TEXT_FILE"
    | "RETRIEVAL_ATTEMPT"
    | "EXTRACTION_FORM"
    | "REFERENCE_ENTRY"
    | "COHORT_CANDIDATE";
  label: string;
  count: number;
  citations: { id: string; title: string }[];
};

const ownerBlockerDefinitions: {
  kind: Exclude<OwnerRollbackBlocker["kind"], "ACTIVE_AI_RUN">;
  label: string;
  where: Prisma.CitationWhereInput;
}[] = [
  { kind: "STUDY_LINK", label: "linked studies", where: { studyLinks: { some: {} } } },
  { kind: "FULL_TEXT_FILE", label: "full-text files", where: { fullTextLinks: { some: {} } } },
  {
    kind: "RETRIEVAL_ATTEMPT",
    label: "full-text retrieval attempts",
    where: { retrievalAttempts: { some: {} } },
  },
  {
    kind: "EXTRACTION_FORM",
    label: "extraction forms",
    where: { extractionForms: { some: {} } },
  },
  {
    kind: "REFERENCE_ENTRY",
    label: "curated reference entries",
    where: { referenceEntries: { some: {} } },
  },
  {
    kind: "COHORT_CANDIDATE",
    label: "cohort-overlap work",
    where: {
      OR: [{ cohortCandidatesAsA: { some: {} } }, { cohortCandidatesAsB: { some: {} } }],
    },
  },
];

const emptyScreeningHistoryCounts = () => ({
  assignments: 0,
  decisions: 0,
  conflicts: 0,
  adjudications: 0,
  stageResults: 0,
  aiSuggestions: 0,
});

const emptyDeduplicationRollbackCounts = () => ({
  candidates: 0,
  groups: 0,
  retainedCitationsRestored: 0,
  assignmentsRestored: 0,
  conflictsRestored: 0,
});

async function loadBatchDeletionScope(db: Tx, projectId: string, batchId: string) {
  const batch = await db.importBatch.findFirst({
    where: { id: batchId, projectId },
    include: { sourceRecords: { select: { citationId: true } } },
  });
  if (!batch) throw notFound("Import batch");

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
      : await db.citationSourceRecord.findMany({
          where: {
            citationId: { in: linkedCitationIds },
            batchId: { not: batch.id },
          },
          select: { citationId: true },
          distinct: ["citationId"],
        });
  const retainedCitationIds = new Set(
    otherSourceRows.map((row) => row.citationId).filter((id): id is string => id !== null),
  );
  const citationIdsToDelete = linkedCitationIds.filter((id) => !retainedCitationIds.has(id));
  return { batch, citationIdsToDelete, retainedCitationIds };
}

async function findOwnerRollbackBlockers(
  db: Tx,
  projectId: string,
  citationIds: string[],
): Promise<OwnerRollbackBlocker[]> {
  if (citationIds.length === 0) return [];
  const blockers: OwnerRollbackBlocker[] = [];
  for (const definition of ownerBlockerDefinitions) {
    const where: Prisma.CitationWhereInput = {
      projectId,
      id: { in: citationIds },
      AND: [definition.where],
    };
    const count = await db.citation.count({ where });
    if (count === 0) continue;
    const citations = await db.citation.findMany({
      where,
      select: { id: true, title: true },
      orderBy: { createdAt: "asc" },
      take: 5,
    });
    blockers.push({
      kind: definition.kind,
      label: definition.label,
      count,
      citations,
    });
  }
  return blockers;
}

async function countScreeningHistory(db: Tx, projectId: string, citationIds: string[]) {
  if (citationIds.length === 0) return emptyScreeningHistoryCounts();
  const citationWhere = { citationId: { in: citationIds }, stage: { projectId } };
  const [assignments, decisions, conflicts, adjudications, stageResults, aiSuggestions] =
    await Promise.all([
      db.screeningAssignment.count({ where: citationWhere }),
      db.screeningDecision.count({ where: citationWhere }),
      db.screeningConflict.count({ where: citationWhere }),
      db.screeningAdjudication.count({
        where: { conflict: citationWhere },
      }),
      db.citationStageResult.count({ where: citationWhere }),
      db.screeningSuggestion.count({ where: citationWhere }),
    ]);
  return { assignments, decisions, conflicts, adjudications, stageResults, aiSuggestions };
}

async function getDeduplicationRollbackPreview(
  db: Tx,
  projectId: string,
  citationIds: string[],
) {
  if (citationIds.length === 0) {
    return {
      citationsWithRelationships: 0,
      candidates: 0,
      groups: 0,
      retainedCitationsToRestore: 0,
    };
  }
  const candidateWhere: Prisma.DeduplicationCandidateWhereInput = {
    projectId,
    OR: [{ citationAId: { in: citationIds } }, { citationBId: { in: citationIds } }],
  };
  const [citationsWithRelationships, candidates, retainedCitations, candidateGroups] =
    await Promise.all([
      db.citation.count({
        where: {
          projectId,
          id: { in: citationIds },
          OR: [
            { status: "DUPLICATE" },
            { duplicateOfId: { not: null } },
            { duplicates: { some: {} } },
          ],
        },
      }),
      db.deduplicationCandidate.count({ where: candidateWhere }),
      db.citation.count({
        where: { projectId, id: { notIn: citationIds }, duplicateOfId: { in: citationIds } },
      }),
      db.deduplicationCandidate.findMany({
        where: { ...candidateWhere, groupId: { not: null } },
        select: { groupId: true },
        distinct: ["groupId"],
      }),
    ]);
  return {
    citationsWithRelationships,
    candidates,
    groups: candidateGroups.length,
    retainedCitationsToRestore: retainedCitations,
  };
}

export async function getOwnerDeleteBatchPreview(ctx: Ctx, projectId: string, batchId: string) {
  const member = await requirePermission(ctx, projectId, "import.manage");
  if (!member.roles.includes("OWNER")) {
    throw forbidden("Only a project owner can inspect an import screening-history rollback");
  }
  const { batch, citationIdsToDelete, retainedCitationIds } = await loadBatchDeletionScope(
    prisma,
    projectId,
    batchId,
  );
  const [activeAiRun, screeningHistory, deduplication, citationBlockers] = await Promise.all([
    citationIdsToDelete.length > 0
      ? prisma.aiScreeningRun.findFirst({
          where: { projectId, status: { in: ["PENDING", "SUBMITTED"] } },
          select: { id: true },
        })
      : Promise.resolve(null),
    countScreeningHistory(prisma, projectId, citationIdsToDelete),
    getDeduplicationRollbackPreview(prisma, projectId, citationIdsToDelete),
    findOwnerRollbackBlockers(prisma, projectId, citationIdsToDelete),
  ]);
  const blockers: OwnerRollbackBlocker[] = activeAiRun
    ? [
        {
          kind: "ACTIVE_AI_RUN",
          label: "an active AI screening run",
          count: 1,
          citations: [],
        },
        ...citationBlockers,
      ]
    : citationBlockers;
  return {
    id: batch.id,
    canDelete: blockers.length === 0,
    citationsToDelete: citationIdsToDelete.length,
    citationsRetained: retainedCitationIds.size,
    screeningHistory,
    deduplication,
    blockers,
  };
}

// Delete an import batch and roll back citations created only by that batch. The ordinary
// path remains conservative and refuses any downstream work. A separately confirmed,
// OWNER-only path may also remove screening-layer rows; work beyond screening still blocks.
// Citations linked to another import are retained with all of their history intact.
async function deleteBatchInternal(
  ctx: Ctx,
  projectId: string,
  batchId: string,
  options: DeleteBatchOptions,
) {
  const member = await requirePermission(ctx, projectId, "import.manage");
  if (options.deleteScreeningHistory && !member.roles.includes("OWNER")) {
    throw forbidden("Only a project owner can delete screening history with an import");
  }

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

      const { batch, citationIdsToDelete, retainedCitationIds } =
        await loadBatchDeletionScope(tx, projectId, batchId);

      if (options.deleteScreeningHistory && options.confirmation !== batch.filename) {
        throw invalidState("Type the import filename exactly to confirm this owner override");
      }

      const screeningHistoryDeleted = emptyScreeningHistoryCounts();
      const deduplicationHistoryDeleted = emptyDeduplicationRollbackCounts();

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

        if (options.deleteScreeningHistory) {
          const [blocker] = await findOwnerRollbackBlockers(tx, projectId, citationIdsToDelete);
          if (blocker) {
            const example = blocker.citations[0];
            throw invalidState(
              `This import cannot be deleted because ${blocker.count.toLocaleString()} citation${blocker.count === 1 ? " has" : "s have"} ${blocker.label}${example ? ` (for example, “${example.title}”)` : ""}. Remove or reset that work first.`,
            );
          }
        } else {
          const blockedCitation = await tx.citation.findFirst({
            where: {
              projectId,
              id: { in: citationIdsToDelete },
              OR: [
                { status: "DUPLICATE" },
                { duplicateOfId: { not: null } },
                { duplicates: { some: {} } },
                { studyLinks: { some: {} } },
                { fullTextLinks: { some: {} } },
                { retrievalAttempts: { some: {} } },
                { extractionForms: { some: {} } },
                { referenceEntries: { some: {} } },
                { cohortCandidatesAsA: { some: {} } },
                { cohortCandidatesAsB: { some: {} } },
                { dedupCandidatesAsA: { some: { status: { not: "SUGGESTED" } } } },
                { dedupCandidatesAsB: { some: { status: { not: "SUGGESTED" } } } },
                { assignments: { some: {} } },
                { decisions: { some: {} } },
                { conflicts: { some: {} } },
                { stageResults: { some: {} } },
                { aiSuggestions: { some: {} } },
              ],
            },
            select: { title: true },
          });
          if (blockedCitation) {
            throw invalidState(
              `This import cannot be deleted because “${blockedCitation.title}” has downstream review work. Remove or reset that work first.`,
            );
          }
        }

        if (options.deleteScreeningHistory) {
          // A retained citation can have been merged into a canonical supplied only by this
          // import. Restore that retained record (including assignments/conflicts voided by
          // the merge) before the canonical disappears.
          const retainedDuplicates = await tx.citation.findMany({
            where: {
              projectId,
              id: { notIn: citationIdsToDelete },
              duplicateOfId: { in: citationIdsToDelete },
            },
            select: { id: true },
          });
          for (const retained of retainedDuplicates) {
            const restored = await undoMergeInTransaction(tx, ctx, projectId, retained.id);
            deduplicationHistoryDeleted.retainedCitationsRestored += 1;
            deduplicationHistoryDeleted.assignmentsRestored +=
              restored.restoredAssignmentIds.length;
            deduplicationHistoryDeleted.conflictsRestored += restored.restoredConflictIds.length;
          }

          screeningHistoryDeleted.adjudications = (
            await tx.screeningAdjudication.deleteMany({
              where: {
                conflict: {
                  citationId: { in: citationIdsToDelete },
                  stage: { projectId },
                },
              },
            })
          ).count;
          screeningHistoryDeleted.conflicts = (
            await tx.screeningConflict.deleteMany({
              where: {
                citationId: { in: citationIdsToDelete },
                stage: { projectId },
              },
            })
          ).count;
          screeningHistoryDeleted.stageResults = (
            await tx.citationStageResult.deleteMany({
              where: {
                citationId: { in: citationIdsToDelete },
                stage: { projectId },
              },
            })
          ).count;
          screeningHistoryDeleted.decisions = (
            await tx.screeningDecision.deleteMany({
              where: {
                citationId: { in: citationIdsToDelete },
                stage: { projectId },
              },
            })
          ).count;
          screeningHistoryDeleted.assignments = (
            await tx.screeningAssignment.deleteMany({
              where: {
                citationId: { in: citationIdsToDelete },
                stage: { projectId },
              },
            })
          ).count;
          screeningHistoryDeleted.aiSuggestions = (
            await tx.screeningSuggestion.deleteMany({
              where: {
                citationId: { in: citationIdsToDelete },
                stage: { projectId },
              },
            })
          ).count;
        }

        // Owner rollback also removes decided pairs involving the mistaken import. Ordinary
        // deletion remains limited to unreviewed suggestions.
        const dedupCandidates = await tx.deduplicationCandidate.findMany({
          where: {
            projectId,
            ...(options.deleteScreeningHistory ? {} : { status: "SUGGESTED" as const }),
            OR: [
              { citationAId: { in: citationIdsToDelete } },
              { citationBId: { in: citationIdsToDelete } },
            ],
          },
          select: { id: true, groupId: true },
        });
        const candidateIds = dedupCandidates.map((candidate) => candidate.id);
        const groupIds = [
          ...new Set(
            dedupCandidates
              .map((candidate) => candidate.groupId)
              .filter((id): id is string => id !== null),
          ),
        ];
        if (candidateIds.length > 0) {
          deduplicationHistoryDeleted.candidates = (
            await tx.deduplicationCandidate.deleteMany({ where: { id: { in: candidateIds } } })
          ).count;
        }

        if (options.deleteScreeningHistory) {
          // Clear self-relations among citations that are about to be removed. Any retained
          // child was restored above, so no valid record is left pointing at a deleted one.
          await tx.citation.updateMany({
            where: { projectId, id: { in: citationIdsToDelete } },
            data: { duplicateOfId: null },
          });
        }

        await tx.citationIdentifier.deleteMany({
          where: { citationId: { in: citationIdsToDelete } },
        });
        await tx.citationSourceRecord.deleteMany({ where: { batchId: batch.id } });
        await tx.citation.deleteMany({ where: { id: { in: citationIdsToDelete } } });

        if (groupIds.length > 0) {
          deduplicationHistoryDeleted.groups = (
            await tx.deduplicationGroup.deleteMany({
              where: { id: { in: groupIds }, projectId, candidates: { none: {} } },
            })
          ).count;
          await tx.deduplicationGroup.updateMany({
            where: {
              id: { in: groupIds },
              projectId,
              candidates: { some: { status: "SUGGESTED" } },
            },
            data: { status: "OPEN" },
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
        ownerOverride: options.deleteScreeningHistory,
        screeningHistoryDeleted,
        deduplicationHistoryDeleted,
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
        reason: options.reason,
        metadata: result,
      });
      return result;
    },
    { timeout: 60_000 },
  );
}

export async function deleteBatch(ctx: Ctx, projectId: string, batchId: string) {
  return deleteBatchInternal(ctx, projectId, batchId, { deleteScreeningHistory: false });
}

export async function ownerDeleteBatchWithScreeningHistory(
  ctx: Ctx,
  projectId: string,
  batchId: string,
  input: z.infer<typeof ownerDeleteBatchSchema>,
) {
  return deleteBatchInternal(ctx, projectId, batchId, {
    deleteScreeningHistory: true,
    confirmation: input.confirmation,
    reason: input.reason,
  });
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
            // NBIB/RIS records carry an affiliation bag (possibly empty); BibTeX/CSV
            // records lack the field entirely and the column stays null.
            affiliations:
              record.affiliations !== undefined
                ? (record.affiliations as unknown as Prisma.InputJsonValue)
                : undefined,
          },
        });

        const identifiers: { citationId: string; type: IdentifierType; value: string }[] = [];
        if (doi) identifiers.push({ citationId: citation.id, type: "DOI", value: doi });
        if (pmid) identifiers.push({ citationId: citation.id, type: "PMID", value: pmid });
        if (record.url) identifiers.push({ citationId: citation.id, type: "URL", value: record.url });
        for (const registryId of record.registryIds ?? []) {
          identifiers.push({ citationId: citation.id, type: "REGISTRY_ID", value: registryId });
        }
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
