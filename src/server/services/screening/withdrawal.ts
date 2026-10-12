import { randomUUID } from "node:crypto";
import { Prisma } from "@prisma/client";
import { z } from "zod";
import { prisma, type Tx } from "@/server/db";
import type { Ctx } from "@/server/auth/session";
import { requirePermission } from "@/server/permissions";
import { forbidden, invalidState, notFound } from "@/server/errors";
import * as audit from "@/server/services/audit";
import { AuditActions } from "@/server/services/audit";
import { loadPooledCitationGroups, loadPooledState } from "./pooled-state";
import { lockScreeningStages, quotaProgress } from "./quotas";
import { evaluateCitation } from "./index";
import { digest, readPlan, signPlan } from "./recovery-token";

export const withdrawalPreviewSchema = z.object({
  poolId: z.string().min(1),
  reviewerId: z.string().min(1),
  reason: z.string().trim().min(3).max(2000),
});
export const restorationPreviewSchema = z.object({
  withdrawalId: z.string().min(1),
  reason: z.string().trim().min(3).max(2000),
});
export const executeRecoverySchema = z.object({
  token: z.string().min(1).max(20000),
});
const claimsSchema = z
  .object({
    version: z.literal(1),
    operation: z.enum(["withdraw", "restore"]),
    planId: z.string().uuid(),
    actorId: z.string(),
    guidelineId: z.string(),
    poolId: z.string(),
    reviewerId: z.string(),
    reason: z.string().trim().min(3).max(2000),
    withdrawalId: z.string().min(1).optional(),
    fingerprint: z.string().length(64),
    expiresAt: z.number(),
  })
  .refine(
    (claims) =>
      claims.operation === "restore"
        ? Boolean(claims.withdrawalId)
        : claims.withdrawalId === undefined,
    "Recovery operation and batch scope must match",
  );
type Input = z.infer<typeof withdrawalPreviewSchema>;
const originalRowSchema = z.object({
  id: z.string(),
  stageId: z.string(),
  citationId: z.string(),
  reviewerId: z.string(),
  decision: z.literal("EXCLUDE"),
  exclusionReasonId: z.string().nullable(),
  notes: z.string().nullable(),
  labels: z.array(z.string()),
  flaggedForDiscussion: z.boolean(),
  assignmentId: z.string(),
});
const manifestSchema = z.object({
  version: z.literal(1),
  projectIds: z.array(z.string()),
  stageIds: z.array(z.string()),
  groups: z.array(
    z.object({
      citationIds: z.array(z.string()),
      rows: z.array(originalRowSchema),
    }),
  ),
});
const json = (value: unknown) =>
  JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;

async function scope(db: Tx, ctx: Ctx, guidelineId: string, input: Input) {
  await requirePermission(ctx, guidelineId, "project.edit", db);
  const guideline = await db.project.findFirst({
    where: { id: guidelineId, isGuideline: true },
    select: { orgId: true },
  });
  if (!guideline) throw notFound("Guideline");
  const pool = await db.guidelineScreeningPool.findFirst({
    where: { id: input.poolId, guidelineId },
    include: {
      members: {
        orderBy: { order: "asc" },
        include: {
          project: { select: { id: true, title: true, parentProjectId: true } },
        },
      },
    },
  });
  if (!pool) throw notFound("Screening pool");
  if (
    pool.members.length < 2 ||
    pool.members.some((m) => m.project.parentProjectId !== guidelineId)
  )
    throw invalidState("The saved pool membership is inconsistent");
  const projectIds = pool.members.map((m) => m.projectId).sort();
  for (const id of projectIds) {
    await requirePermission(ctx, id, "project.edit", db);
    await requirePermission(
      { userId: input.reviewerId },
      id,
      "screening.decide",
      db,
    );
  }
  await requirePermission(
    { userId: input.reviewerId },
    guidelineId,
    "screening.decide",
    db,
  );
  const stages = await db.screeningStage.findMany({
    where: { projectId: { in: projectIds }, type: "TITLE_ABSTRACT" },
    orderBy: { id: "asc" },
  });
  if (
    stages.length !== projectIds.length ||
    stages.some(
      (s) => s.reviewersPerCitation !== stages[0]!.reviewersPerCitation,
    ) ||
    stages.some(
      (s) => s.maybeGeneratesConflict !== stages[0]!.maybeGeneratesConflict,
    )
  )
    throw invalidState(
      "Every pooled PICO must have a compatible title/abstract stage",
    );
  return { pool, projectIds, stages, orgId: guideline.orgId };
}

async function inspect(
  db: Tx,
  ctx: Ctx,
  guidelineId: string,
  input: Input,
  withdrawalId?: string,
) {
  const family = await scope(db, ctx, guidelineId, input);
  const stageIds = family.stages.map((s) => s.id);
  const allGroups = await loadPooledCitationGroups(db, family.projectIds);
  const batch = withdrawalId
    ? await db.screeningWithdrawal.findFirst({
        where: {
          id: withdrawalId,
          guidelineId,
          poolId: input.poolId,
          reviewerId: input.reviewerId,
        },
      })
    : null;
  if (withdrawalId && !batch) throw notFound("Withdrawal");
  if (batch?.restoredAt)
    throw invalidState("This withdrawal has already been restored");
  const manifest = batch ? manifestSchema.parse(batch.manifest) : null;
  const target = await db.screeningDecision.findMany({
    where: manifest
      ? { id: { in: manifest.groups.flatMap((g) => g.rows.map((r) => r.id)) } }
      : {
          reviewerId: input.reviewerId,
          withdrawnAt: null,
          decision: "EXCLUDE",
          stageId: { in: stageIds },
          citation: { status: "ACTIVE" },
        },
    orderBy: { id: "asc" },
  });
  const selectedIds = new Set(
    manifest
      ? manifest.groups.flatMap((g) => g.citationIds)
      : target.map((d) => d.citationId),
  );
  const groups = allGroups.filter((g) => g.some((c) => selectedIds.has(c.id)));
  if (groups.length > 200 || target.length > 2000)
    throw invalidState(
      "Recovery exceeds the bounded 200-group limit; involve a maintainer",
    );
  const citationIds = [
    ...new Set(groups.flatMap((g) => g.map((c) => c.id))),
  ].sort();
  const pairWhere = {
    citationId: { in: citationIds },
    stageId: { in: stageIds },
  };
  // Reopening deletes a materialized result, but does not erase its history.
  // Retained result audits therefore also hold the group for owner review.
  const resultHistory = citationIds.length
    ? await db.$queryRaw<{ id: string; citationId: string }[]>(Prisma.sql`
    SELECT "id", COALESCE("newValue"->>'citationId', "previousValue"->>'citationId') AS "citationId"
    FROM "AuditEvent" WHERE "projectId" IN (${Prisma.join(family.projectIds)})
    AND "entityType" = 'CitationStageResult'
    AND COALESCE("newValue"->>'citationId', "previousValue"->>'citationId') IN (${Prisma.join(citationIds)})
    AND COALESCE("newValue"->>'stageId', "previousValue"->>'stageId') IN (${Prisma.join(stageIds)})
    ORDER BY "id"`)
    : [];
  const [
    states,
    rows,
    assignments,
    results,
    conflicts,
    citations,
    downstreamAssignments,
    downstreamDecisions,
    downstreamResults,
    quota,
  ] = await Promise.all([
    loadPooledState(db, family.projectIds, stageIds, groups),
    db.screeningDecision.findMany({ where: pairWhere, orderBy: { id: "asc" } }),
    db.screeningAssignment.findMany({
      where: pairWhere,
      orderBy: { id: "asc" },
    }),
    db.citationStageResult.findMany({
      where: pairWhere,
      orderBy: { id: "asc" },
    }),
    db.screeningConflict.findMany({
      where: pairWhere,
      include: { adjudication: true },
      orderBy: { id: "asc" },
    }),
    db.citation.findMany({
      where: { id: { in: citationIds } },
      orderBy: { id: "asc" },
      select: {
        id: true,
        title: true,
        projectId: true,
        status: true,
        updatedAt: true,
        _count: {
          select: {
            studyLinks: true,
            fullTextLinks: true,
            retrievalAttempts: true,
            extractionForms: true,
            referenceEntries: true,
            cohortCandidatesAsA: true,
            cohortCandidatesAsB: true,
          },
        },
      },
    }),
    db.screeningAssignment.findMany({
      where: { citationId: { in: citationIds }, stage: { type: "FULL_TEXT" } },
      orderBy: { id: "asc" },
    }),
    db.screeningDecision.findMany({
      where: { citationId: { in: citationIds }, stage: { type: "FULL_TEXT" } },
      orderBy: { id: "asc" },
    }),
    db.citationStageResult.findMany({
      where: { citationId: { in: citationIds }, stage: { type: "FULL_TEXT" } },
      orderBy: { id: "asc" },
    }),
    quotaProgress(db, { poolId: input.poolId }, input.reviewerId, allGroups),
  ]);
  const views = groups.map((group, index) => {
    const ids = group.map((c) => c.id).sort();
    const inGroup = (r: { citationId: string }) => ids.includes(r.citationId);
    const own = rows.filter(
      (r) => inGroup(r) && r.reviewerId === input.reviewerId,
    );
    const saved = manifest?.groups.find((g) =>
      g.citationIds.some((id) => ids.includes(id)),
    );
    const reasons: string[] = [];
    if (states[index]!.needsSynchronization)
      reasons.push("INCONSISTENT_LINKED_STATE");
    const metadataSignatures = ids.map((id) =>
      digest(
        rows
          .filter((d) => d.citationId === id && !d.withdrawnAt)
          .map((d) => [d.reviewerId, d.labels, d.flaggedForDiscussion])
          .sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
      ),
    );
    if (new Set(metadataSignatures).size > 1)
      reasons.push("INCONSISTENT_LINKED_STATE");
    if (results.some(inGroup)) reasons.push("FINALIZED_STAGE_RESULT");
    if (resultHistory.some(inGroup)) reasons.push("FINALIZED_STAGE_HISTORY");
    if (
      conflicts.some(
        (r) => inGroup(r) && (r.adjudication || r.status === "RESOLVED"),
      )
    )
      reasons.push("ADJUDICATION_HISTORY");
    if (
      citations.some(
        (c) =>
          ids.includes(c.id) &&
          Object.values(c._count).some((count) => count > 0),
      ) ||
      downstreamAssignments.some(inGroup) ||
      downstreamDecisions.some(inGroup) ||
      downstreamResults.some(inGroup)
    )
      reasons.push("DOWNSTREAM_HISTORY");
    if (states[index]!.reviewedBy.size > family.stages[0]!.reviewersPerCitation)
      reasons.push("REVIEW_CAPACITY_INCONSISTENT");
    if (!manifest) {
      if (
        own.length !== ids.length ||
        own.some((d) => d.withdrawnAt || d.decision !== "EXCLUDE") ||
        own.some(
          (d) =>
            !assignments.some(
              (a) =>
                a.stageId === d.stageId &&
                a.citationId === d.citationId &&
                a.reviewerId === input.reviewerId &&
                a.status === "COMPLETED",
            ),
        )
      )
        reasons.push("TARGET_VOTES_NOT_ALL_ACTIVE_EXCLUDE");
    } else {
      if (
        !saved ||
        digest(saved.citationIds) !== digest(ids) ||
        digest(manifest.projectIds) !== digest(family.projectIds) ||
        digest(manifest.stageIds) !== digest(stageIds)
      )
        reasons.push("POOL_OR_GROUP_CHANGED");
      if (
        !saved ||
        saved.rows.length !== own.length ||
        own.some(
          (d) =>
            d.withdrawalId !== batch!.id ||
            !d.withdrawnAt ||
            d.decision !== "EXCLUDE" ||
            !saved.rows.some(
              (r) =>
                r.id === d.id &&
                r.stageId === d.stageId &&
                r.citationId === d.citationId &&
                r.reviewerId === d.reviewerId &&
                r.decision === d.decision &&
                r.exclusionReasonId === d.exclusionReasonId &&
                r.notes === d.notes &&
                digest(r.labels) === digest(d.labels) &&
                r.flaggedForDiscussion === d.flaggedForDiscussion,
            ) ||
            !assignments.some(
              (a) =>
                a.id === saved.rows.find((r) => r.id === d.id)?.assignmentId &&
                a.status === "PENDING",
            ),
        )
      )
        reasons.push("WITHDRAWN_VOTE_CHANGED");
      if (
        states[index]!.reviewedBy.size >= family.stages[0]!.reviewersPerCitation
      )
        reasons.push("NO_REVIEW_CAPACITY");
    }
    return {
      id: states[index]!.id,
      citationIds: ids,
      title:
        citations.find((c) => c.id === ids[0])?.title ?? "Unavailable abstract",
      copies: ids.length,
      decisionIds: own.map((d) => d.id),
      reasons: [...new Set(reasons)],
      eligible: reasons.length === 0,
    };
  });
  if (
    manifest &&
    (groups.length !== manifest.groups.length ||
      manifest.groups.some(
        (g) =>
          !groups.some(
            (current) =>
              digest(current.map((c) => c.id).sort()) === digest(g.citationIds),
          ),
      ))
  )
    throw invalidState(
      "The retained recovery groups no longer match the active pool",
    );
  if (
    manifest &&
    quota?.remaining !== null &&
    quota &&
    quota.remaining < views.filter((g) => g.eligible).length
  )
    for (const view of views) {
      view.reasons.push("RESTORATION_EXCEEDS_QUOTA");
      view.eligible = false;
    }
  const eligible = views.filter((g) => g.eligible);
  const executable = !manifest || views.every((g) => g.eligible);
  const originals = groups
    .filter((_, i) => views[i]!.eligible)
    .map((group) => ({
      citationIds: group.map((c) => c.id).sort(),
      rows: rows
        .filter(
          (d) =>
            group.some((c) => c.id === d.citationId) &&
            d.reviewerId === input.reviewerId,
        )
        .map((d) => ({
          id: d.id,
          stageId: d.stageId,
          citationId: d.citationId,
          reviewerId: d.reviewerId,
          decision: d.decision,
          exclusionReasonId: d.exclusionReasonId,
          notes: d.notes,
          labels: d.labels,
          flaggedForDiscussion: d.flaggedForDiscussion,
          assignmentId: assignments.find(
            (a) =>
              a.citationId === d.citationId &&
              a.stageId === d.stageId &&
              a.reviewerId === d.reviewerId,
          )!.id,
        })),
    }));
  // The fingerprint covers all current rows, including co-reviewer changes, but those
  // values never enter the response, signed payload, recovery manifest, or recovery audit.
  const fingerprint = digest({
    pool: { id: family.pool.id, updatedAt: family.pool.updatedAt },
    projects: family.projectIds,
    stages: family.stages,
    groups,
    target,
    rows,
    assignments,
    results,
    resultHistory,
    conflicts,
    citations,
    downstreamAssignments,
    downstreamDecisions,
    downstreamResults,
    quota,
    batch,
  });
  return {
    family,
    groups: views,
    originals,
    fingerprint,
    executable,
    eligible,
    manifest,
    batch,
    allGroups,
    quota,
    summary: {
      selectedGroups: views.length,
      eligibleGroups: executable ? eligible.length : 0,
      heldGroups: executable ? views.length - eligible.length : views.length,
      linkedDecisions: executable
        ? eligible.reduce((sum, g) => sum + g.decisionIds.length, 0)
        : 0,
      completedBefore: quota?.completed ?? null,
      remainingBefore: quota?.remaining ?? null,
    },
  };
}

export async function previewWithdrawal(
  ctx: Ctx,
  guidelineId: string,
  raw: Input,
) {
  const input = withdrawalPreviewSchema.parse(raw);
  return prisma.$transaction(
    async (tx) => {
      const state = await inspect(tx, ctx, guidelineId, input);
      return previewResult(ctx, guidelineId, input, state, "withdraw");
    },
    {
      isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead,
      timeout: 30000,
    },
  );
}
function previewResult(
  ctx: Ctx,
  guidelineId: string,
  input: Input,
  state: Awaited<ReturnType<typeof inspect>>,
  operation: "withdraw" | "restore",
  withdrawalId?: string,
) {
  const expiresAt = Date.now() + 10 * 60 * 1000;
  const planId = randomUUID();
  const token = state.summary.eligibleGroups
    ? signPlan({
        version: 1,
        operation,
        planId,
        actorId: ctx.userId,
        guidelineId,
        ...input,
        withdrawalId,
        fingerprint: state.fingerprint,
        expiresAt,
      })
    : null;
  return {
    dryRun: true,
    operation,
    planId,
    expiresAt: new Date(expiresAt).toISOString(),
    token,
    pool: {
      id: state.family.pool.id,
      name: state.family.pool.name,
      projects: state.family.pool.members.map((m) => m.project),
    },
    reviewerId: input.reviewerId,
    groups: state.groups,
    summary: state.summary,
  };
}
export async function previewRestoration(
  ctx: Ctx,
  guidelineId: string,
  raw: z.infer<typeof restorationPreviewSchema>,
) {
  const input = restorationPreviewSchema.parse(raw);
  await requirePermission(ctx, guidelineId, "project.edit");
  const batch = await prisma.screeningWithdrawal.findFirst({
    where: { id: input.withdrawalId, guidelineId },
  });
  if (!batch) throw notFound("Withdrawal");
  const selection = {
    poolId: batch.poolId,
    reviewerId: batch.reviewerId,
    reason: input.reason,
  };
  return prisma.$transaction(
    async (tx) => {
      const state = await inspect(tx, ctx, guidelineId, selection, batch.id);
      return previewResult(
        ctx,
        guidelineId,
        selection,
        state,
        "restore",
        batch.id,
      );
    },
    {
      isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead,
      timeout: 30000,
    },
  );
}
export async function listWithdrawals(ctx: Ctx, guidelineId: string) {
  await requirePermission(ctx, guidelineId, "project.edit");
  return prisma.screeningWithdrawal.findMany({
    where: { guidelineId },
    orderBy: { createdAt: "desc" },
    take: 50,
    select: {
      id: true,
      poolId: true,
      reviewerId: true,
      createdAt: true,
      restoredAt: true,
      summary: true,
    },
  });
}

export async function executeRecovery(
  ctx: Ctx,
  guidelineId: string,
  token: string,
) {
  const claims = claimsSchema.parse(
    readPlan(executeRecoverySchema.parse({ token }).token),
  );
  if (claims.actorId !== ctx.userId || claims.guidelineId !== guidelineId)
    throw forbidden("Recovery plan belongs to another actor or guideline");
  const input = {
    poolId: claims.poolId,
    reviewerId: claims.reviewerId,
    reason: claims.reason,
  };
  return prisma.$transaction(
    async (tx) => {
      const initial = await scope(tx, ctx, guidelineId, input);
      // Same order as pooled submissions: corpus guards, stage guards, quota, citation.
      for (const id of initial.projectIds)
        await tx.$queryRaw`SELECT "id" FROM "Project" WHERE "id" = ${id} FOR SHARE`;
      await lockScreeningStages(
        tx,
        initial.stages.map((s) => s.id),
      );
      await tx.$queryRaw`SELECT "id" FROM "ScreeningQuota" WHERE "poolId" = ${input.poolId} AND "reviewerId" = ${input.reviewerId} FOR UPDATE`;
      // Keep both participants' authorization stable through commit, including removal
      // or role changes while a preflight is waiting for a screening writer.
      const participantIds = [
        ...new Set([ctx.userId, input.reviewerId]),
      ].sort();
      await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "OrganizationMember" WHERE "orgId" = ${initial.orgId}
      AND "userId" IN (${Prisma.join(participantIds)}) ORDER BY "id" FOR SHARE`);
      await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "ProjectMember"
      WHERE "projectId" IN (${Prisma.join([guidelineId, ...initial.projectIds])})
      AND "userId" IN (${Prisma.join(participantIds)}) ORDER BY "id" FOR SHARE`);
      await scope(tx, ctx, guidelineId, input);
      const replay =
        claims.operation === "withdraw"
          ? await tx.screeningWithdrawal.findFirst({
              where: {
                id: claims.planId,
                guidelineId,
                actorId: ctx.userId,
                reviewerId: input.reviewerId,
                poolId: input.poolId,
              },
            })
          : await tx.screeningWithdrawal.findFirst({
              where: {
                id: claims.withdrawalId,
                guidelineId,
                restoreRequestId: claims.planId,
                restoreActorId: ctx.userId,
              },
            });
      if (replay) {
        if (claims.operation === "withdraw" && replay.restoredAt)
          throw invalidState(
            "The withdrawal was subsequently restored; preview a new operation",
          );
        return {
          withdrawalId: replay.id,
          replayed: true,
          summary:
            claims.operation === "withdraw"
              ? replay.summary
              : replay.restoreSummary,
        };
      }
      if (Date.now() > claims.expiresAt)
        throw invalidState("Recovery plan expired; preview again");
      let state = await inspect(
        tx,
        ctx,
        guidelineId,
        input,
        claims.withdrawalId,
      );
      const ids = state.groups.flatMap((g) => g.citationIds).sort();
      if (ids.length)
        await tx.$queryRaw(
          Prisma.sql`SELECT "id" FROM "Citation" WHERE "id" IN (${Prisma.join(ids)}) ORDER BY "id" FOR UPDATE`,
        );
      state = await inspect(tx, ctx, guidelineId, input, claims.withdrawalId);
      if (
        state.fingerprint !== claims.fingerprint ||
        !state.executable ||
        !state.summary.eligibleGroups
      )
        throw invalidState(
          "Recovery state changed; nothing was changed. Preview again",
        );
      const withdrawalId =
        claims.operation === "withdraw" ? claims.planId : claims.withdrawalId!;
      const now = new Date();
      const manifest =
        claims.operation === "withdraw"
          ? manifestSchema.parse({
              version: 1,
              projectIds: state.family.projectIds,
              stageIds: state.family.stages.map((s) => s.id),
              groups: state.originals,
            })
          : state.manifest!;
      if (claims.operation === "withdraw")
        await tx.screeningWithdrawal.create({
          data: {
            id: withdrawalId,
            guidelineId,
            poolId: input.poolId,
            reviewerId: input.reviewerId,
            actorId: ctx.userId,
            reason: input.reason,
            manifest: json(manifest),
            summary: json(state.summary),
          },
        });
      const stages = new Map(state.family.stages.map((s) => [s.id, s]));
      for (const group of manifest.groups) {
        for (const row of group.rows) {
          const previous = await tx.screeningDecision.findUniqueOrThrow({
            where: { id: row.id },
          });
          const decision = await tx.screeningDecision.update({
            where: { id: row.id },
            data: {
              withdrawnAt: claims.operation === "withdraw" ? now : null,
              withdrawalId:
                claims.operation === "withdraw" ? withdrawalId : null,
            },
          });
          await tx.screeningAssignment.update({
            where: { id: row.assignmentId },
            data: {
              status: claims.operation === "withdraw" ? "PENDING" : "COMPLETED",
            },
          });
          await audit.record(tx, {
            projectId: stages.get(row.stageId)!.projectId,
            userId: ctx.userId,
            entityType: "ScreeningDecision",
            entityId: row.id,
            action:
              claims.operation === "withdraw"
                ? AuditActions.SCREENING_DECISION_WITHDRAWN
                : AuditActions.SCREENING_DECISION_RESTORED,
            previousValue: previous,
            newValue: decision,
            reason: input.reason,
            metadata: { withdrawalId, pooledScreeningPoolId: input.poolId },
          });
          if (claims.operation === "withdraw") {
            const conflict = await tx.screeningConflict.findFirst({
              where: {
                stageId: row.stageId,
                citationId: row.citationId,
                status: "OPEN",
              },
            });
            if (conflict) {
              await tx.screeningConflict.update({
                where: { id: conflict.id },
                data: { status: "VOIDED" },
              });
              await audit.record(tx, {
                projectId: stages.get(row.stageId)!.projectId,
                userId: ctx.userId,
                entityType: "ScreeningConflict",
                entityId: conflict.id,
                action: AuditActions.SCREENING_CONFLICT_VOIDED,
                previousValue: { status: "OPEN" },
                newValue: { status: "VOIDED" },
                reason: input.reason,
                metadata: { withdrawalId },
              });
            }
          } else
            await evaluateCitation(
              tx,
              ctx,
              stages.get(row.stageId)!,
              row.citationId,
            );
        }
      }
      const after = await quotaProgress(
        tx,
        { poolId: input.poolId },
        input.reviewerId,
        state.allGroups,
      );
      const summary = {
        ...state.summary,
        completedAfter: after?.completed ?? null,
        remainingAfter: after?.remaining ?? null,
      };
      if (claims.operation === "withdraw")
        await tx.screeningWithdrawal.update({
          where: { id: withdrawalId },
          data: { summary: json(summary) },
        });
      else
        await tx.screeningWithdrawal.update({
          where: { id: withdrawalId },
          data: {
            restoredAt: now,
            restoreRequestId: claims.planId,
            restoreActorId: ctx.userId,
            restoreSummary: json(summary),
          },
        });
      await audit.record(tx, {
        projectId: guidelineId,
        userId: ctx.userId,
        entityType: "ScreeningWithdrawal",
        entityId: withdrawalId,
        action:
          claims.operation === "withdraw"
            ? AuditActions.SCREENING_WITHDRAWAL_APPLIED
            : AuditActions.SCREENING_WITHDRAWAL_RESTORED,
        reason: input.reason,
        newValue: summary,
        metadata: {
          poolId: input.poolId,
          reviewerId: input.reviewerId,
          decisionIds: manifest.groups.flatMap((g) => g.rows.map((r) => r.id)),
        },
      });
      return { withdrawalId, replayed: false, summary };
    },
    { maxWait: 10000, timeout: 30000 },
  );
}
