// Citations read service: filterable list (cursor-paginated) + tenant-scoped detail.
// Normalization helpers live in ./normalize (shared with import + dedup).
import { z } from "zod";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/server/db";
import { conflict, forbidden, invalidState, notFound } from "@/server/errors";
import type { Ctx } from "@/server/auth/session";
import { can, requirePermission } from "@/server/permissions";
import * as audit from "@/server/services/audit";
import { AuditActions } from "@/server/services/audit";

export const addCitationAbstractSchema = z.object({
  abstract: z
    .string()
    .trim()
    .min(1, "Abstract cannot be empty")
    .max(50_000, "Abstract must be 50,000 characters or fewer"),
});

export const listCitationsQuerySchema = z.object({
  status: z.enum(["ACTIVE", "DUPLICATE"]).default("ACTIVE"),
  q: z.string().trim().max(500).optional(),
  batchId: z.string().optional(),
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

export type ListCitationsQuery = z.infer<typeof listCitationsQuerySchema>;

export async function listCitations(ctx: Ctx, projectId: string, query: ListCitationsQuery) {
  await requirePermission(ctx, projectId, "project.view");

  const where: Prisma.CitationWhereInput = { projectId, status: query.status };
  if (query.q) where.title = { contains: query.q, mode: "insensitive" };
  if (query.batchId) where.sourceRecords = { some: { batchId: query.batchId } };

  const rows = await prisma.citation.findMany({
    where,
    orderBy: { id: "asc" },
    take: query.limit + 1,
    ...(query.cursor ? { cursor: { id: query.cursor }, skip: 1 } : {}),
    include: {
      identifiers: { select: { id: true, type: true, value: true } },
      sourceRecords: {
        select: {
          batchId: true,
          batch: { select: { source: { select: { id: true, name: true } } } },
        },
      },
    },
  });

  const hasMore = rows.length > query.limit;
  const page = hasMore ? rows.slice(0, query.limit) : rows;
  const items = page.map(({ sourceRecords, ...citation }) => {
    const sources = new Map<string, { id: string; name: string }>();
    for (const sr of sourceRecords) sources.set(sr.batch.source.id, sr.batch.source);
    return { ...citation, sources: [...sources.values()] };
  });

  return {
    items,
    nextCursor: hasMore && page.length > 0 ? page[page.length - 1]!.id : null,
  };
}

export async function getCitation(ctx: Ctx, projectId: string, citationId: string) {
  await requirePermission(ctx, projectId, "project.view");
  // Tenant-scoped by-id load (R9): a citation from another project is a 404.
  const citation = await prisma.citation.findFirst({
    where: { id: citationId, projectId },
    include: {
      identifiers: { select: { id: true, type: true, value: true } },
      sourceRecords: {
        orderBy: { createdAt: "asc" },
        include: {
          batch: {
            select: {
              id: true,
              filename: true,
              format: true,
              status: true,
              createdAt: true,
              source: { select: { id: true, name: true } },
            },
          },
        },
      },
      duplicateOf: { select: { id: true, title: true, status: true } },
      duplicates: { select: { id: true, title: true, status: true } },
    },
  });
  if (!citation) throw notFound("Citation");
  return citation;
}

// Fill a metadata gap without rewriting the immutable imported source record. Project
// managers/librarians may do this anywhere; a screener may do it only for a citation assigned
// to them. Existing abstracts cannot be overwritten through this narrow endpoint.
export async function addCitationAbstract(
  ctx: Ctx,
  projectId: string,
  citationId: string,
  input: z.infer<typeof addCitationAbstractSchema>,
) {
  const member = await requirePermission(ctx, projectId, "project.view");
  const canManageMetadata =
    can(member.roles, "project.edit") || can(member.roles, "import.manage");

  return prisma.$transaction(async (tx) => {
    // R9: the route project is part of the citation lookup, so cross-project IDs are 404s.
    const citation = await tx.citation.findFirst({
      where: { id: citationId, projectId },
    });
    if (!citation) throw notFound("Citation");
    if (citation.status !== "ACTIVE") {
      throw invalidState("A merged duplicate's metadata cannot be changed");
    }

    if (!canManageMetadata) {
      if (!can(member.roles, "screening.decide")) throw forbidden();
      const assignment = await tx.screeningAssignment.findFirst({
        where: {
          citationId: citation.id,
          reviewerId: ctx.userId,
          status: { not: "VOIDED" },
          stage: { projectId },
        },
        select: { id: true },
      });
      if (!assignment) {
        throw forbidden("You can add an abstract only to a citation assigned to you");
      }
    }

    if (citation.abstract?.trim()) {
      throw invalidState("This citation already has an abstract");
    }

    // Match the value and update timestamp read above so two simultaneous additions cannot
    // silently overwrite one another.
    const write = await tx.citation.updateMany({
      where: {
        id: citation.id,
        projectId,
        abstract: citation.abstract,
        updatedAt: citation.updatedAt,
      },
      data: { abstract: input.abstract },
    });
    if (write.count !== 1) {
      throw conflict(
        "The citation changed while you were adding the abstract; refresh and try again",
      );
    }

    // Prescreen scores were generated from the old title/abstract payload. Remove them rather
    // than showing reviewers a score whose input no longer matches the citation.
    const invalidatedSuggestions = await tx.screeningSuggestion.deleteMany({
      where: { citationId: citation.id },
    });
    const updated = await tx.citation.findUniqueOrThrow({ where: { id: citation.id } });

    await audit.record(tx, {
      projectId,
      userId: ctx.userId,
      entityType: "Citation",
      entityId: citation.id,
      action: AuditActions.CITATION_ABSTRACT_ADDED,
      previousValue: { abstract: citation.abstract },
      newValue: { abstract: updated.abstract },
      metadata: { aiSuggestionsInvalidated: invalidatedSuggestions.count },
    });

    return {
      citation: { id: updated.id, abstract: updated.abstract },
      aiSuggestionsInvalidated: invalidatedSuggestions.count,
    };
  });
}
