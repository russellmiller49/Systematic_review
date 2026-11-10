// Pooled title/abstract adjudication. Per-PICO rows remain authoritative; writes fan
// out atomically. Historical differences are deliberately never reconciled here.
import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import { Prisma } from "@prisma/client";
import { prisma, type Tx } from "@/server/db";
import type { Ctx } from "@/server/auth/session";
import { requirePermission } from "@/server/permissions";
import { invalidState, notFound, validationError } from "@/server/errors";
import * as audit from "@/server/services/audit";
import { AuditActions } from "@/server/services/audit";
import { loadPooledState } from "./pooled-state";
import { lockScreeningStages } from "./quotas";

export const pooledConflictsQuerySchema = z.object({
  poolId: z.string().trim().min(1),
});
const targetSchema = pooledConflictsQuerySchema.extend({
  citationIds: z
    .array(z.string().min(1))
    .min(1)
    .max(200)
    .refine(
      (ids) => new Set(ids).size === ids.length,
      "Citations must be unique",
    ),
  stateToken: z.string().regex(/^[a-f0-9]{64}$/),
  reason: z.string().trim().min(3).max(20_000),
});
export const adjudicatePooledConflictSchema = targetSchema.extend({
  finalDecision: z.enum(["INCLUDE", "EXCLUDE"]),
  exclusionReasonLabel: z.string().trim().min(1).max(300).nullable().optional(),
});
export const reopenPooledConflictSchema = targetSchema;

async function family(tx: Tx, ctx: Ctx, guidelineId: string, poolId: string) {
  await requirePermission(ctx, guidelineId, "screening.adjudicate", tx);
  const pool = await tx.guidelineScreeningPool.findFirst({
    where: {
      id: poolId,
      guidelineId,
      guideline: { isGuideline: true, parentProjectId: null },
    },
    include: {
      members: { orderBy: { order: "asc" }, include: { project: true } },
    },
  });
  if (!pool) throw notFound("Screening pool");
  if (
    !pool.members.length ||
    pool.members.some((m) => m.project.parentProjectId !== guidelineId)
  )
    throw invalidState(
      "The screening pool membership changed. Refresh the workspace.",
    );
  for (const member of pool.members)
    await requirePermission(ctx, member.projectId, "screening.adjudicate", tx);
  const projectIds = pool.members.map((m) => m.projectId).sort();
  const stages = await tx.screeningStage.findMany({
    where: { projectId: { in: projectIds }, type: "TITLE_ABSTRACT" },
    orderBy: { id: "asc" },
  });
  if (
    stages.length !== projectIds.length ||
    new Set(stages.map((s) => s.reviewersPerCitation)).size !== 1 ||
    new Set(stages.map((s) => s.maybeGeneratesConflict)).size !== 1
  )
    throw invalidState(
      "The pooled title/abstract stage configuration is incompatible.",
    );
  const siblings = await tx.project.findMany({
    where: { parentProjectId: guidelineId },
    orderBy: { createdAt: "asc" },
    select: { id: true },
  });
  return {
    pool,
    projectIds,
    stages,
    picos: pool.members.map((m) => ({
      id: m.projectId,
      title: m.project.title,
      picoNumber: siblings.findIndex((p) => p.id === m.projectId) + 1,
    })),
  };
}
type Family = Awaited<ReturnType<typeof family>>;

async function snapshot(tx: Tx, f: Family) {
  const where = {
    stageId: { in: f.stages.map((s) => s.id) },
    citation: { status: "ACTIVE" as const },
  };
  const [states, conflicts, decisions, assignments, results] =
    await Promise.all([
      loadPooledState(
        tx,
        f.projectIds,
        f.stages.map((s) => s.id),
      ),
      tx.screeningConflict.findMany({
        where,
        orderBy: { id: "asc" },
        include: {
          adjudication: {
            include: {
              adjudicator: { select: { id: true, name: true } },
              exclusionReason: { select: { label: true } },
            },
          },
        },
      }),
      tx.screeningDecision.findMany({
        where: { ...where, withdrawnAt: null },
        orderBy: { id: "asc" },
        include: {
          reviewer: { select: { id: true, name: true } },
          exclusionReason: { select: { label: true } },
        },
      }),
      tx.screeningAssignment.findMany({ where, orderBy: { id: "asc" } }),
      tx.citationStageResult.findMany({ where, orderBy: { id: "asc" } }),
    ]);
  return states.flatMap((state) => {
    const ids = new Set(state.group.map((c) => c.id));
    const linked = conflicts.filter((c) => ids.has(c.citationId));
    const votes = decisions.filter((d) => ids.has(d.citationId));
    const stageResults = results.filter((r) => ids.has(r.citationId));
    if (
      !stageResults.length &&
      !linked.some((c) => c.status === "OPEN" || c.status === "RESOLVED")
    )
      return [];
    const liveConflict = state.rows.every((r) => {
      if (r.liveDecisions.length < f.stages[0]!.reviewersPerCitation)
        return false;
      const values = new Set(r.liveDecisions.map((d) => d.decision));
      return (
        (values.size === 1 && values.has("MAYBE")) ||
        (values.has("INCLUDE") && values.has("EXCLUDE")) ||
        (values.has("MAYBE") && f.stages[0]!.maybeGeneratesConflict)
      );
    });
    const adjudicationKey = (
      a: NonNullable<(typeof linked)[number]["adjudication"]>,
    ) =>
      JSON.stringify([
        a.adjudicatorId,
        a.finalDecision,
        a.reason,
        a.exclusionReason?.label ?? null,
      ]);
    const duplicateProject =
      new Set(state.group.map((c) => c.projectId)).size !== state.group.length;
    const conflictingDoi =
      new Set(
        state.group.map((c) => c.doi?.trim().toLowerCase()).filter(Boolean),
      ).size > 1;
    const conflictingPmid =
      new Set(state.group.map((c) => c.pmid?.trim()).filter(Boolean)).size > 1;
    const identityAmbiguous =
      duplicateProject || conflictingDoi || conflictingPmid;
    const synchronizationReason = identityAmbiguous
      ? "This group contains multiple copies within a PICO or conflicting DOI/PMID identifiers. Review citation identity before pooled adjudication."
      : state.needsSynchronization
        ? "The linked PICOs have different screening histories. Review these differences separately before pooled adjudication."
        : "The linked conflict or adjudication records do not agree. Review these differences separately.";
    const open =
      liveConflict &&
      !identityAmbiguous &&
      !state.needsSynchronization &&
      linked.length === ids.size &&
      linked.every((c) => c.status === "OPEN") &&
      stageResults.length === 0;
    const adjudicated =
      linked.length === ids.size &&
      linked.every((c) => c.status === "RESOLVED" && c.adjudication) &&
      new Set(
        linked.map((c) =>
          c.adjudication ? adjudicationKey(c.adjudication) : "missing",
        ),
      ).size === 1 &&
      stageResults.length === ids.size &&
      stageResults.every(
        (r) =>
          r.resolvedVia === "ADJUDICATION" &&
          r.outcome === linked[0]!.adjudication?.finalDecision,
      );
    const consensus =
      linked.every((c) => c.status === "VOIDED") &&
      stageResults.length === ids.size &&
      stageResults.every(
        (r) =>
          r.resolvedVia === "CONSENSUS" || r.resolvedVia === "SINGLE_REVIEWER",
      ) &&
      new Set(stageResults.map((r) => `${r.resolvedVia}:${r.outcome}`)).size ===
        1;
    const resolved =
      !identityAmbiguous &&
      !state.needsSynchronization &&
      (adjudicated || consensus);
    const status = open
      ? ("OPEN" as const)
      : resolved
        ? ("RESOLVED" as const)
        : ("NEEDS_SYNCHRONIZATION" as const);
    const stateToken = createHash("sha256")
      .update(
        JSON.stringify({
          poolId: f.pool.id,
          projectIds: f.projectIds,
          stages: f.stages.map((s) => [
            s.id,
            s.reviewersPerCitation,
            s.maybeGeneratesConflict,
            s.updatedAt,
          ]),
          group: state.group,
          conflicts: linked,
          decisions: votes,
          assignments: assignments.filter((a) => ids.has(a.citationId)),
          results: stageResults,
        }),
      )
      .digest("hex");
    return [
      {
        state,
        linked,
        votes,
        stageResults,
        status,
        stateToken,
        synchronizationReason,
      },
    ];
  });
}

export async function listPooledConflicts(
  ctx: Ctx,
  guidelineId: string,
  input: z.infer<typeof pooledConflictsQuerySchema>,
) {
  input = pooledConflictsQuerySchema.parse(input);
  return prisma.$transaction(
    async (tx) => {
      const f = await family(tx, ctx, guidelineId, input.poolId);
      const rows = await snapshot(tx, f);
      const [citations, reasons, criteria] = await Promise.all([
        tx.citation.findMany({
          where: {
            id: { in: rows.flatMap((r) => r.state.group.map((c) => c.id)) },
          },
          select: {
            id: true,
            title: true,
            abstract: true,
            authors: true,
            year: true,
            doi: true,
            pmid: true,
          },
        }),
        tx.exclusionReason.findMany({
          where: {
            projectId: { in: f.projectIds },
            isActive: true,
            stage: { in: ["TITLE_ABSTRACT", "BOTH"] },
          },
          orderBy: [{ order: "asc" }, { label: "asc" }],
        }),
        tx.eligibilityCriterion.findMany({
          where: { protocol: { projectId: { in: f.projectIds } } },
          orderBy: [{ type: "asc" }, { order: "asc" }],
          include: { protocol: { select: { projectId: true } } },
        }),
      ]);
      return {
        pool: { id: f.pool.id, name: f.pool.name },
        picos: f.picos,
        reasons: [...new Set(reasons.map((r) => r.label))]
          .filter((label) =>
            f.projectIds.every((id) =>
              reasons.some((r) => r.projectId === id && r.label === label),
            ),
          )
          .map((label) => ({ label })),
        criteria: criteria.map((c) => ({
          id: c.id,
          projectId: c.protocol.projectId,
          type: c.type,
          category: c.category,
          text: c.text,
          order: c.order,
        })),
        items: rows.map((r) => ({
          id: r.state.id,
          citationIds: r.state.group.map((c) => c.id).sort(),
          stateToken: r.stateToken,
          citation: citations
            .filter((c) => r.state.group.some((g) => g.id === c.id))
            .sort(
              (a, b) => (b.abstract?.length ?? 0) - (a.abstract?.length ?? 0),
            )[0]!,
          status: r.status,
          synchronizationReason:
            r.status === "NEEDS_SYNCHRONIZATION"
              ? r.synchronizationReason
              : null,
          picos: f.picos.filter((p) =>
            r.state.group.some((c) => c.projectId === p.id),
          ),
          // Never collapse conflicting historical votes into one misleading reviewer row.
          decisions: r.votes
            .filter(
              (d) =>
                r.status === "NEEDS_SYNCHRONIZATION" ||
                d.citationId === r.state.group[0]!.id,
            )
            .map((d) => ({
              reviewer: d.reviewer,
              decision: d.decision,
              notes: d.notes,
              citationId: d.citationId,
              projectId: r.state.group.find((c) => c.id === d.citationId)!
                .projectId,
              exclusionReason: d.exclusionReason,
            })),
          adjudication:
            r.status === "RESOLVED" && r.linked[0]?.status === "RESOLVED"
              ? r.linked[0].adjudication
              : null,
          finalOutcome:
            r.status === "RESOLVED" ? r.stageResults[0]!.outcome : null,
          historicalAdjudications: r.linked
            .filter((c) => c.adjudication)
            .map((c) => ({
              projectId: r.state.group.find((g) => g.id === c.citationId)!
                .projectId,
              citationId: c.citationId,
              conflictStatus: c.status,
              adjudication: c.adjudication!,
            })),
        })),
        summary: {
          open: rows.filter((r) => r.status === "OPEN").length,
          resolved: rows.filter((r) => r.status === "RESOLVED").length,
          needsSynchronization: rows.filter(
            (r) => r.status === "NEEDS_SYNCHRONIZATION",
          ).length,
        },
      };
    },
    {
      isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead,
      timeout: 30_000,
    },
  );
}

async function withLockedTarget<T>(
  ctx: Ctx,
  guidelineId: string,
  input: z.infer<typeof targetSchema>,
  write: (
    tx: Tx,
    f: Family,
    row: Awaited<ReturnType<typeof snapshot>>[number],
    metadata: Record<string, unknown>,
  ) => Promise<T>,
) {
  const before = await family(prisma, ctx, guidelineId, input.poolId);
  return prisma.$transaction(
    async (tx) => {
      // Project guards exclude import/dedup changes. Exclusive, sorted stage guards
      // serialize this infrequent administrative operation against reviewers and pool
      // configuration. Never upgrade locks obtained by the pooled reviewer writer.
      for (const id of before.projectIds)
        await tx.$queryRaw`SELECT "id" FROM "Project" WHERE "id" = ${id} FOR SHARE`;
      // Full-text assignment creation also takes its stage lock. Holding every stage
      // prevents a new full-text assignment racing the downstream check during reopen.
      const guardedStages = await tx.screeningStage.findMany({
        where: { projectId: { in: before.projectIds } },
        select: { id: true },
      });
      await lockScreeningStages(
        tx,
        guardedStages.map((s) => s.id),
      );
      await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "OrganizationMember"
      WHERE "orgId" IN (${Prisma.join([...new Set(before.pool.members.map((m) => m.project.orgId))])})
      AND "userId" = ${ctx.userId} ORDER BY "id" FOR SHARE`);
      await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "ProjectMember"
      WHERE "projectId" IN (${Prisma.join([guidelineId, ...before.projectIds])})
      AND "userId" = ${ctx.userId} ORDER BY "id" FOR SHARE`);
      const f = await family(tx, ctx, guidelineId, input.poolId);
      if (
        JSON.stringify(before.projectIds) !== JSON.stringify(f.projectIds) ||
        JSON.stringify(before.stages.map((s) => s.id)) !==
          JSON.stringify(f.stages.map((s) => s.id))
      )
        throw invalidState(
          "The screening pool changed. Refresh before continuing.",
        );
      const rows = await snapshot(tx, f);
      const ids = new Set(input.citationIds);
      const row = rows.find((r) => r.state.group.some((c) => ids.has(c.id)));
      if (
        !row ||
        row.state.group.length !== ids.size ||
        row.state.group.some((c) => !ids.has(c.id)) ||
        row.stateToken !== input.stateToken
      )
        throw invalidState(
          "This pooled abstract changed. Refresh before continuing.",
        );
      const metadata = {
        pooledOperationId: randomUUID(),
        pooledGuidelineId: guidelineId,
        pooledScreeningPoolId: f.pool.id,
        pooledScreeningPoolName: f.pool.name,
        pooledProjectIds: f.projectIds,
        pooledCitationIds: [...ids].sort(),
      };
      return write(tx, f, row, metadata);
    },
    { timeout: 30_000 },
  );
}

export async function adjudicatePooledConflict(
  ctx: Ctx,
  guidelineId: string,
  input: z.infer<typeof adjudicatePooledConflictSchema>,
) {
  input = adjudicatePooledConflictSchema.parse(input);
  return withLockedTarget(
    ctx,
    guidelineId,
    input,
    async (tx, f, row, metadata) => {
      if (row.status !== "OPEN")
        throw invalidState(
          "Only synchronized open pooled conflicts can be adjudicated. Historical differences require a separate review.",
        );
      const reasons =
        input.finalDecision === "EXCLUDE" && input.exclusionReasonLabel
          ? await tx.exclusionReason.findMany({
              where: {
                projectId: { in: f.projectIds },
                label: input.exclusionReasonLabel,
                isActive: true,
                stage: { in: ["TITLE_ABSTRACT", "BOTH"] },
              },
            })
          : [];
      if (
        input.finalDecision === "EXCLUDE" &&
        (!input.exclusionReasonLabel ||
          f.projectIds.some((id) => !reasons.some((r) => r.projectId === id)))
      )
        throw validationError(
          "Choose an exclusion reason active in every PICO in this pool.",
        );
      const now = new Date();
      for (const conflict of row.linked) {
        const projectId = row.state.group.find(
          (c) => c.id === conflict.citationId,
        )!.projectId;
        const exclusionReasonId =
          reasons.find((r) => r.projectId === projectId)?.id ?? null;
        const data = {
          adjudicatorId: ctx.userId,
          finalDecision: input.finalDecision,
          exclusionReasonId,
          reason: input.reason,
        };
        const adjudication = await tx.screeningAdjudication.upsert({
          where: { conflictId: conflict.id },
          create: { conflictId: conflict.id, ...data },
          update: data,
        });
        await tx.screeningConflict.update({
          where: { id: conflict.id },
          data: { status: "RESOLVED", resolvedAt: now },
        });
        const result = await tx.citationStageResult.create({
          data: {
            stageId: conflict.stageId,
            citationId: conflict.citationId,
            outcome: input.finalDecision,
            resolvedVia: "ADJUDICATION",
            resolvedAt: now,
          },
        });
        await audit.record(tx, {
          projectId,
          userId: ctx.userId,
          entityType: "ScreeningAdjudication",
          entityId: adjudication.id,
          action: AuditActions.SCREENING_CONFLICT_ADJUDICATED,
          previousValue: conflict.adjudication ?? undefined,
          newValue: { conflictId: conflict.id, ...data },
          reason: input.reason,
          metadata,
        });
        await audit.record(tx, {
          projectId,
          userId: ctx.userId,
          entityType: "CitationStageResult",
          entityId: result.id,
          action: AuditActions.SCREENING_RESULT_CREATED,
          newValue: result,
          metadata,
        });
      }
      return {
        finalDecision: input.finalDecision,
        appliedToCitationRecords: row.linked.length,
        appliedToPicos: new Set(row.state.group.map((c) => c.projectId)).size,
      };
    },
  );
}

export async function reopenPooledConflict(
  ctx: Ctx,
  guidelineId: string,
  input: z.infer<typeof reopenPooledConflictSchema>,
) {
  input = reopenPooledConflictSchema.parse(input);
  return withLockedTarget(
    ctx,
    guidelineId,
    input,
    async (tx, _f, row, metadata) => {
      if (row.status !== "RESOLVED")
        throw invalidState(
          "Only synchronized resolved pooled conflicts can be reopened.",
        );
      const downstreamWhere = {
        citationId: { in: input.citationIds },
        stage: { type: "FULL_TEXT" as const },
      };
      const downstream = await Promise.all([
        tx.screeningAssignment.count({
          where: { ...downstreamWhere, status: { not: "VOIDED" } },
        }),
        tx.screeningDecision.count({
          where: { ...downstreamWhere, withdrawnAt: null },
        }),
        tx.citationStageResult.count({ where: downstreamWhere }),
      ]);
      if (downstream.some(Boolean))
        throw invalidState(
          "Full-text work already exists for a linked citation. Review that downstream work before reopening the pooled abstract.",
        );
      for (const result of row.stageResults) {
        const projectId = row.state.group.find(
          (c) => c.id === result.citationId,
        )!.projectId;
        await tx.citationStageResult.delete({ where: { id: result.id } });
        await audit.record(tx, {
          projectId,
          userId: ctx.userId,
          entityType: "CitationStageResult",
          entityId: result.id,
          action: AuditActions.SCREENING_RESULT_REOPENED,
          previousValue: result,
          reason: input.reason,
          metadata,
        });
      }
      await tx.screeningConflict.updateMany({
        where: { id: { in: row.linked.map((c) => c.id) } },
        data: { status: "VOIDED" },
      });
      return {
        reopened: true,
        appliedToCitationRecords: row.state.group.length,
        appliedToPicos: new Set(row.state.group.map((c) => c.projectId)).size,
      };
    },
  );
}
