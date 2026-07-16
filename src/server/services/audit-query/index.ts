// Audit query API with the R1 blind filter (docs/09-design-review-resolutions.md).
//
// AuditEvent rows for SENSITIVE entity types (screening/extraction/RoB work products) are
// visible only to (a) the event's actor, (b) holders of project.edit, (c) holders of the
// domain's adjudicate capability. Everyone else gets those rows excluded entirely — a static
// where-clause, no per-citation blinding join.

import { z } from "zod";
import type { Prisma, ProjectRole } from "@prisma/client";
import { prisma } from "@/server/db";
import type { Ctx } from "@/server/auth/session";
import { requirePermission, can } from "@/server/permissions";

// R1 sensitive entity-type groups, keyed by the capability that unlocks them.
//
// AI entities (AiScreeningRun, AiExtractionRun) are deliberately NOT sensitive: their audit
// events carry only run configuration and counts — no reviewer votes or per-citation
// decisions — and the suggestion rows themselves are never audited. Screeners seeing that a
// prescreen run happened leaks nothing about co-reviewers.
export const SCREENING_SENSITIVE_ENTITY_TYPES = [
  "ScreeningDecision",
  "ScreeningConflict",
  "ScreeningAdjudication",
] as const;

export const EXTRACTION_SENSITIVE_ENTITY_TYPES = [
  "ExtractionValue",
  "ExtractionForm",
  "ExtractionConflict",
] as const;

export const ROB_SENSITIVE_ENTITY_TYPES = [
  "RiskOfBiasAssessment",
  "RiskOfBiasJudgment",
  "RiskOfBiasSignalingResponse",
  "RiskOfBiasConflict",
] as const;

export const SENSITIVE_ENTITY_TYPES: readonly string[] = [
  ...SCREENING_SENSITIVE_ENTITY_TYPES,
  ...EXTRACTION_SENSITIVE_ENTITY_TYPES,
  ...ROB_SENSITIVE_ENTITY_TYPES,
];

const MAX_LIMIT = 100;
const DEFAULT_LIMIT = 50;

// Route-facing schema (query-string values arrive as strings → coerce).
export const listAuditEventsSchema = z.object({
  entityType: z.string().min(1).optional(),
  entityId: z.string().min(1).optional(),
  userId: z.string().min(1).optional(),
  actionPrefix: z.string().min(1).optional(),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
  cursor: z.string().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(MAX_LIMIT).optional(),
});

export interface AuditQueryFilters {
  entityType?: string;
  entityId?: string;
  userId?: string;
  actionPrefix?: string;
  from?: Date;
  to?: Date;
  cursor?: string;
  limit?: number;
}

export interface AuditEventRow {
  id: string;
  entityType: string;
  entityId: string;
  action: string;
  previousValue: unknown;
  newValue: unknown;
  reason: string | null;
  metadata: unknown;
  createdAt: Date;
  actor: { id: string; name: string };
}

export interface AuditEventPage {
  events: AuditEventRow[];
  nextCursor: string | null;
}

// The R1 visibility clause for a caller with the given roles. Returns null when the caller
// sees everything (project.edit).
function blindVisibilityClause(
  roles: readonly ProjectRole[],
  callerUserId: string,
): Prisma.AuditEventWhereInput | null {
  if (can(roles, "project.edit")) return null;
  const visibility: Prisma.AuditEventWhereInput[] = [
    // Non-sensitive rows are visible to every audit.view holder.
    { entityType: { notIn: [...SENSITIVE_ENTITY_TYPES] } },
    // Your own events are always visible to you.
    { userId: callerUserId },
  ];
  if (can(roles, "screening.adjudicate")) {
    visibility.push({ entityType: { in: [...SCREENING_SENSITIVE_ENTITY_TYPES] } });
  }
  if (can(roles, "extraction.adjudicate")) {
    visibility.push({ entityType: { in: [...EXTRACTION_SENSITIVE_ENTITY_TYPES] } });
  }
  if (can(roles, "rob.adjudicate")) {
    visibility.push({ entityType: { in: [...ROB_SENSITIVE_ENTITY_TYPES] } });
  }
  return { OR: visibility };
}

export async function listAuditEvents(
  ctx: Ctx,
  projectId: string,
  filters: AuditQueryFilters = {},
): Promise<AuditEventPage> {
  const member = await requirePermission(ctx, projectId, "audit.view");
  const limit = Math.min(filters.limit ?? DEFAULT_LIMIT, MAX_LIMIT);

  const base: Prisma.AuditEventWhereInput = {
    projectId,
    ...(filters.entityType ? { entityType: filters.entityType } : {}),
    ...(filters.entityId ? { entityId: filters.entityId } : {}),
    ...(filters.userId ? { userId: filters.userId } : {}),
    ...(filters.actionPrefix ? { action: { startsWith: filters.actionPrefix } } : {}),
    ...(filters.from || filters.to
      ? {
          createdAt: {
            ...(filters.from ? { gte: filters.from } : {}),
            ...(filters.to ? { lte: filters.to } : {}),
          },
        }
      : {}),
  };

  const visibility = blindVisibilityClause(member.roles, ctx.userId);
  const where: Prisma.AuditEventWhereInput = visibility ? { AND: [base, visibility] } : base;

  const rows = await prisma.auditEvent.findMany({
    where,
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: limit + 1,
    ...(filters.cursor ? { cursor: { id: filters.cursor }, skip: 1 } : {}),
    include: { user: { select: { id: true, name: true } } },
  });

  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;

  return {
    events: page.map((e) => ({
      id: e.id,
      entityType: e.entityType,
      entityId: e.entityId,
      action: e.action,
      previousValue: e.previousValue,
      newValue: e.newValue,
      reason: e.reason,
      metadata: e.metadata,
      createdAt: e.createdAt,
      actor: e.user,
    })),
    nextCursor: hasMore ? (page[page.length - 1]?.id ?? null) : null,
  };
}
