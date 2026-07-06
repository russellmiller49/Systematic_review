// Citations read service: filterable list (cursor-paginated) + tenant-scoped detail.
// Normalization helpers live in ./normalize (shared with import + dedup).
import { z } from "zod";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/server/db";
import { notFound } from "@/server/errors";
import type { Ctx } from "@/server/auth/session";
import { requirePermission } from "@/server/permissions";

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
