import { Prisma, type ScreeningKeywordCategory } from "@prisma/client";
import { z } from "zod";
import { prisma, type Tx } from "@/server/db";
import { conflict, notFound, validationError } from "@/server/errors";
import type { Ctx } from "@/server/auth/session";
import { requirePermission } from "@/server/permissions";
import * as audit from "@/server/services/audit";
import { AuditActions } from "@/server/services/audit";
import {
  cleanScreeningKeywordTerm,
  normalizeScreeningKeywordTerm,
} from "@/lib/screening-keywords";

const MAX_KEYWORDS_PER_PROJECT = 100;
export const UNMATCHED_KEYWORD_GROUP = "__unmatched__";

const keywordTermSchema = z.string().trim().min(1).max(100);
const categorySchema = z.enum(["INCLUDE", "EXCLUDE"]);

export const createScreeningKeywordsSchema = z.object({
  terms: z.array(keywordTermSchema).min(1).max(25),
  category: categorySchema,
});

export const updateScreeningKeywordSchema = z
  .object({
    term: keywordTermSchema.optional(),
    category: categorySchema.optional(),
  })
  .refine((input) => input.term !== undefined || input.category !== undefined, {
    message: "At least one keyword field must be supplied",
  });

export type ScreeningKeywordGroup = string | undefined;

function keywordFields(row: {
  term: string;
  normalizedTerm: string;
  category: ScreeningKeywordCategory;
}) {
  return {
    term: row.term,
    normalizedTerm: row.normalizedTerm,
    category: row.category,
  };
}

export async function listScreeningKeywords(ctx: Ctx, projectId: string) {
  await requirePermission(ctx, projectId, "project.view");
  return prisma.screeningKeyword.findMany({
    where: { projectId },
    orderBy: [{ category: "asc" }, { createdAt: "asc" }, { id: "asc" }],
  });
}

export async function createScreeningKeywords(
  ctx: Ctx,
  projectId: string,
  input: z.infer<typeof createScreeningKeywordsSchema>,
) {
  await requirePermission(ctx, projectId, "screening.decide");
  const deduped = new Map<string, string>();
  for (const rawTerm of input.terms) {
    const term = cleanScreeningKeywordTerm(rawTerm);
    const normalizedTerm = normalizeScreeningKeywordTerm(term);
    if (normalizedTerm) deduped.set(normalizedTerm, term);
  }
  const candidates = [...deduped.entries()].map(([normalizedTerm, term]) => ({
    term,
    normalizedTerm,
  }));

  try {
    return await prisma.$transaction(async (tx) => {
      const existing = await tx.screeningKeyword.findMany({
        where: {
          projectId,
          normalizedTerm: { in: candidates.map((candidate) => candidate.normalizedTerm) },
        },
        select: { normalizedTerm: true },
      });
      const existingTerms = new Set(existing.map((keyword) => keyword.normalizedTerm));
      const fresh = candidates.filter((candidate) => !existingTerms.has(candidate.normalizedTerm));
      const currentCount = await tx.screeningKeyword.count({ where: { projectId } });
      if (currentCount + fresh.length > MAX_KEYWORDS_PER_PROJECT) {
        throw validationError(
          `A project can have at most ${MAX_KEYWORDS_PER_PROJECT} screening keywords`,
        );
      }

      const created = [];
      for (const candidate of fresh) {
        const keyword = await tx.screeningKeyword.create({
          data: {
            projectId,
            term: candidate.term,
            normalizedTerm: candidate.normalizedTerm,
            category: input.category,
            createdById: ctx.userId,
          },
        });
        await audit.record(tx, {
          projectId,
          userId: ctx.userId,
          entityType: "ScreeningKeyword",
          entityId: keyword.id,
          action: AuditActions.SCREENING_KEYWORD_CREATED,
          newValue: keywordFields(keyword),
        });
        created.push(keyword);
      }

      return {
        created,
        skippedTerms: candidates
          .filter((candidate) => existingTerms.has(candidate.normalizedTerm))
          .map((candidate) => candidate.term),
      };
    });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      throw conflict("One of these screening keywords already exists");
    }
    throw error;
  }
}

export async function updateScreeningKeyword(
  ctx: Ctx,
  projectId: string,
  keywordId: string,
  input: z.infer<typeof updateScreeningKeywordSchema>,
) {
  await requirePermission(ctx, projectId, "screening.decide");
  try {
    return await prisma.$transaction(async (tx) => {
      const before = await tx.screeningKeyword.findFirst({
        where: { id: keywordId, projectId },
      });
      if (!before) throw notFound("Screening keyword");
      const term = input.term === undefined ? before.term : cleanScreeningKeywordTerm(input.term);
      const keyword = await tx.screeningKeyword.update({
        where: { id: before.id },
        data: {
          term,
          normalizedTerm: normalizeScreeningKeywordTerm(term),
          category: input.category,
        },
      });
      await audit.record(tx, {
        projectId,
        userId: ctx.userId,
        entityType: "ScreeningKeyword",
        entityId: keyword.id,
        action: AuditActions.SCREENING_KEYWORD_UPDATED,
        previousValue: keywordFields(before),
        newValue: keywordFields(keyword),
      });
      return keyword;
    });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      throw conflict("A screening keyword with this term already exists");
    }
    throw error;
  }
}

export async function deleteScreeningKeyword(
  ctx: Ctx,
  projectId: string,
  keywordId: string,
) {
  await requirePermission(ctx, projectId, "screening.decide");
  return prisma.$transaction(async (tx) => {
    const before = await tx.screeningKeyword.findFirst({
      where: { id: keywordId, projectId },
    });
    if (!before) throw notFound("Screening keyword");
    await tx.screeningKeyword.delete({ where: { id: before.id } });
    await audit.record(tx, {
      projectId,
      userId: ctx.userId,
      entityType: "ScreeningKeyword",
      entityId: before.id,
      action: AuditActions.SCREENING_KEYWORD_DELETED,
      previousValue: keywordFields(before),
    });
    return { id: before.id };
  });
}

function termWhere(term: string): Prisma.CitationWhereInput {
  return {
    OR: [
      { title: { contains: term, mode: "insensitive" } },
      { abstract: { contains: term, mode: "insensitive" } },
    ],
  };
}

// Used by both the personal queue and blind-safe admin overview. The returned predicate only
// reads citation metadata; it never joins decisions or reviewer work.
export async function screeningKeywordCitationWhere(
  tx: Tx,
  projectId: string,
  group: ScreeningKeywordGroup,
): Promise<Prisma.CitationWhereInput | undefined> {
  if (!group) return undefined;
  if (group === UNMATCHED_KEYWORD_GROUP) {
    const keywords = await tx.screeningKeyword.findMany({
      where: { projectId },
      select: { term: true },
    });
    if (keywords.length === 0) return undefined;
    return { NOT: { OR: keywords.flatMap((keyword) => termWhere(keyword.term).OR ?? []) } };
  }
  const keyword = await tx.screeningKeyword.findFirst({
    where: { id: group, projectId },
    select: { term: true },
  });
  if (!keyword) throw notFound("Screening keyword");
  return termWhere(keyword.term);
}
