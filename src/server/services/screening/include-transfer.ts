/** Administrative, explicitly allowlisted historical INCLUDE transfer. Not an HTTP API. */
import { createHash } from "node:crypto";
import { Prisma } from "@prisma/client";
import { z } from "zod";
import { prisma, type Tx } from "@/server/db";
import { requirePermission } from "@/server/permissions";
import { lockScreeningStages } from "./quotas";
import { loadPooledCitationGroups, loadPooledState } from "./pooled-state";

const id = z.string().min(1);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
export const includeTransferManifestSchema = z
  .object({
    version: z.literal(1),
    batchId: id,
    guidelineId: id,
    poolId: id,
    sourceAdjudicatorId: id,
    sourceProjectId: id,
    expectedGroups: z.number().int().positive(),
    expectedTargets: z.number().int().positive(),
    groups: z
      .array(
        z
          .object({
            sourceAdjudicationId: id,
            sourceDigest: digest,
            sourceConflictDigest: digest,
            sourceResultDigest: digest,
            citationIds: z.array(id).min(2),
            targetCitationIds: z.array(id).min(1),
          })
          .strict(),
      )
      .min(1),
  })
  .strict();
export type IncludeTransferManifest = z.infer<
  typeof includeTransferManifestSchema
>;
export function canonical(value: unknown): string {
  const normalized = JSON.parse(JSON.stringify(value));
  const sort = (v: unknown): unknown =>
    Array.isArray(v)
      ? v.map(sort)
      : v !== null && typeof v === "object"
        ? Object.fromEntries(
            Object.entries(v)
              .sort(([a], [b]) => a.localeCompare(b))
              .map(([k, x]) => [k, sort(x)]),
          )
        : v;
  return JSON.stringify(sort(normalized));
}
export function transferDigest(value: unknown) {
  return createHash("sha256").update(canonical(value)).digest("hex");
}
export function transferRowId(
  batchId: string,
  kind: string,
  citationId: string,
) {
  return `transfer_${transferDigest([batchId, kind, citationId])}`;
}
export function validateManifest(value: unknown) {
  const m = includeTransferManifestSchema.parse(value);
  const all = m.groups.flatMap((g) => g.citationIds);
  if (
    m.groups.length !== m.expectedGroups ||
    m.groups.reduce((n, g) => n + g.targetCitationIds.length, 0) !==
      m.expectedTargets ||
    new Set(all).size !== all.length ||
    new Set(m.groups.map((g) => g.sourceAdjudicationId)).size !==
      m.groups.length ||
    m.groups.some(
      (g) =>
        new Set(g.targetCitationIds).size !== g.targetCitationIds.length ||
        g.targetCitationIds.length !== g.citationIds.length - 1 ||
        g.targetCitationIds.some((c) => !g.citationIds.includes(c)),
    )
  )
    throw new Error("Invalid or overlapping transfer allowlist");
  return m;
}
function equal(a: unknown, b: unknown, message: string) {
  if (canonical(a) !== canonical(b)) throw new Error(message);
}
const sorted = (ids: string[]) => [...ids].sort();
const json = (v: unknown) =>
  JSON.parse(JSON.stringify(v)) as Prisma.InputJsonValue;

async function locked<T>(
  m: IncludeTransferManifest,
  actorId: string,
  work: (tx: Tx, state: Awaited<ReturnType<typeof readState>>) => Promise<T>,
) {
  if (actorId === m.sourceAdjudicatorId)
    throw new Error("Migration actor must be distinct from source adjudicator");
  // Discovery only. All authoritative reads and permissions are repeated after guards.
  const initial = await prisma.guidelineScreeningPool.findUniqueOrThrow({
    where: { id: m.poolId },
    include: { members: true },
  });
  const projects = sorted(initial.members.map((x) => x.projectId));
  return prisma.$transaction(
    async (tx) => {
      await tx.$executeRaw`SET LOCAL lock_timeout = '10s'`;
      for (const p of sorted([m.guidelineId, ...projects]))
        await tx.$queryRaw`SELECT "id" FROM "Project" WHERE "id" = ${p} FOR SHARE`;
      const stages = await tx.screeningStage.findMany({
        where: { projectId: { in: projects } },
        orderBy: { id: "asc" },
      });
      await lockScreeningStages(
        tx,
        stages.map((s) => s.id),
      );
      // All downstream inserts reference Citation and take FK KEY SHARE. FOR UPDATE
      // excludes those inserts without blocking unrelated projects' downstream work.
      const citationIds = sorted(m.groups.flatMap((g) => g.citationIds));
      await tx.$queryRaw(
        Prisma.sql`SELECT "id" FROM "Citation" WHERE "id" IN (${Prisma.join(citationIds)}) ORDER BY "id" FOR UPDATE`,
      );
      const userIds = sorted([...new Set([actorId, m.sourceAdjudicatorId])]);
      await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "OrganizationMember" WHERE "orgId" IN
      (SELECT "orgId" FROM "Project" WHERE "id" IN (${Prisma.join([m.guidelineId, ...projects])}))
      AND "userId" IN (${Prisma.join(userIds)}) ORDER BY "id" FOR SHARE`);
      await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "ProjectMember" WHERE "projectId" IN (${Prisma.join([m.guidelineId, ...projects])})
      AND "userId" IN (${Prisma.join(userIds)}) ORDER BY "id" FOR SHARE`);
      const pool = await tx.guidelineScreeningPool.findUniqueOrThrow({
        where: { id: m.poolId },
        include: {
          members: { orderBy: { id: "asc" }, include: { project: true } },
          guideline: true,
        },
      });
      equal(
        sorted(pool.members.map((x) => x.projectId)),
        projects,
        "Pool membership changed during lock acquisition",
      );
      if (
        pool.guidelineId !== m.guidelineId ||
        !pool.guideline.isGuideline ||
        pool.guideline.parentProjectId ||
        pool.members.some((x) => x.project.parentProjectId !== m.guidelineId) ||
        !projects.includes(m.sourceProjectId)
      )
        throw new Error("Invalid guideline pool");
      const authority = [];
      for (const userId of sorted([
        ...new Set([actorId, m.sourceAdjudicatorId]),
      ])) {
        for (const projectId of [m.guidelineId, ...projects]) {
          const member = await requirePermission(
            { userId },
            projectId,
            "screening.adjudicate",
            tx,
          );
          if (
            userId === actorId &&
            !member.roles.some((r) => r === "OWNER" || r === "ADMIN")
          )
            throw new Error(
              "Migration requires an owner/admin actor in every linked project",
            );
          authority.push(member);
        }
      }
      const freshStages = await tx.screeningStage.findMany({
        where: { projectId: { in: projects } },
        orderBy: { id: "asc" },
      });
      equal(stages, freshStages, "Stages changed during lock acquisition");
      const ta = stages.filter((s) => s.type === "TITLE_ABSTRACT");
      if (
        ta.length !== projects.length ||
        new Set(ta.map((s) => s.reviewersPerCitation)).size !== 1 ||
        new Set(ta.map((s) => s.maybeGeneratesConflict)).size !== 1
      )
        throw new Error("Incompatible pooled stages");
      const orgAuthority = await tx.organizationMember.findMany({
        where: {
          orgId: {
            in: [
              ...new Set([
                pool.guideline.orgId,
                ...pool.members.map((x) => x.project.orgId),
              ]),
            ],
          },
          userId: { in: userIds },
        },
        orderBy: { id: "asc" },
      });
      return work(
        tx,
        await readState(tx, m, {
          pool,
          stages,
          authority: { projects: authority, organizations: orgAuthority },
          projects,
          ta,
        }),
      );
    },
    { timeout: 120_000 },
  );
}
async function readState(
  tx: Tx,
  m: IncludeTransferManifest,
  context: {
    pool: unknown;
    stages: Array<{ id: string; type: string }>;
    authority: unknown;
    projects: string[];
    ta: Array<{
      id: string;
      reviewersPerCitation: number;
      maybeGeneratesConflict: boolean;
    }>;
  },
) {
  const corpus = await loadPooledCitationGroups(tx, context.projects);
  const wanted = m.groups.flatMap((g) => g.citationIds);
  const selected = corpus.filter((g) => g.some((c) => wanted.includes(c.id)));
  const states = await loadPooledState(
    tx,
    context.projects,
    context.ta.map((s) => s.id),
    selected,
  );
  const where = { citationId: { in: wanted } };
  const [citations, decisions, assignments, conflicts, results, downstream] =
    await Promise.all([
      tx.citation.findMany({
        where: { id: { in: wanted } },
        orderBy: { id: "asc" },
        include: { identifiers: { orderBy: { id: "asc" } } },
      }),
      // Include withdrawn history in digest/backup, but never treat it as a live vote.
      tx.screeningDecision.findMany({ where, orderBy: { id: "asc" } }),
      tx.screeningAssignment.findMany({ where, orderBy: { id: "asc" } }),
      tx.screeningConflict.findMany({
        where,
        include: { adjudication: true },
        orderBy: { id: "asc" },
      }),
      tx.citationStageResult.findMany({ where, orderBy: { id: "asc" } }),
      Promise.all([
        tx.citationFullTextLink.count({ where }),
        tx.fullTextRetrievalAttempt.count({ where }),
        tx.extractionForm.count({ where }),
        tx.studyReportLink.count({ where }),
      ]),
    ]);
  const taIds = new Set(context.ta.map((s) => s.id));
  if (
    downstream.some(Boolean) ||
    decisions.some((d) => !taIds.has(d.stageId)) ||
    assignments.some((a) => !taIds.has(a.stageId)) ||
    conflicts.some((c) => !taIds.has(c.stageId)) ||
    results.some((r) => !taIds.has(r.stageId))
  )
    throw new Error("Downstream work exists; transfer is blocked");
  const protocols = await tx.protocol.findMany({
    where: { projectId: { in: [m.guidelineId, ...context.projects] } },
    orderBy: { id: "asc" },
    include: {
      criteria: { orderBy: { id: "asc" } },
      picoQuestions: { orderBy: { id: "asc" } },
      outcomes: { orderBy: { id: "asc" } },
    },
  });
  const reasonConfiguration = await tx.exclusionReason.findMany({
    where: { projectId: { in: [m.guidelineId, ...context.projects] } },
    orderBy: { id: "asc" },
  });
  const sharedDigest = transferDigest({
    ...context,
    corpus,
    protocols,
    reasonConfiguration,
  });
  const groups = m.groups.map((approved) => {
    const state = states.find((s) =>
      s.group.some((c) => approved.citationIds.includes(c.id)),
    );
    if (!state) throw new Error("Missing approved group");
    equal(
      sorted(state.group.map((c) => c.id)),
      sorted(approved.citationIds),
      "Group identity or corpus changed",
    );
    if (
      new Set(state.group.map((c) => c.projectId)).size !==
        state.group.length ||
      new Set(
        state.group.map((c) => c.doi?.trim().toLowerCase()).filter(Boolean),
      ).size > 1 ||
      new Set(state.group.map((c) => c.pmid?.trim()).filter(Boolean)).size >
        1 ||
      state.rows.some((r) => r.invalid)
    )
      throw new Error("Ambiguous identity or invalid live vote state");
    // Historical source outcomes differ by design; reviewer evidence must still agree.
    const signatures = state.rows.map((r) =>
      transferDigest(
        r.liveDecisions
          .map((d) => [
            d.reviewerId,
            d.decision,
            d.notes,
            d.exclusionReason?.label ?? null,
          ])
          .sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
      ),
    );
    if (new Set(signatures).size !== 1)
      throw new Error("Reviewer evidence differs across linked copies");
    for (const r of state.rows) {
      const values = new Set(r.liveDecisions.map((d) => d.decision));
      if (
        r.liveDecisions.length < context.ta[0]!.reviewersPerCitation ||
        !(
          (values.has("INCLUDE") && values.has("EXCLUDE")) ||
          (values.has("MAYBE") &&
            (values.size === 1 || context.ta[0]!.maybeGeneratesConflict))
        )
      )
        throw new Error("Live votes no longer warrant adjudication");
    }
    const has = (r: { citationId: string }) =>
      approved.citationIds.includes(r.citationId);
    const linked = conflicts.filter(has);
    const source = linked.find(
      (c) => c.adjudication?.id === approved.sourceAdjudicationId,
    );
    if (
      !source?.resolvedAt ||
      !source.adjudication ||
      source.status !== "RESOLVED" ||
      source.adjudication.finalDecision !== "INCLUDE" ||
      source.adjudication.adjudicatorId !== m.sourceAdjudicatorId ||
      source.adjudication.exclusionReasonId !== null ||
      citations.find((c) => c.id === source.citationId)?.projectId !==
        m.sourceProjectId
    )
      throw new Error("Source adjudication is no longer eligible");
    equal(
      transferDigest(source.adjudication),
      approved.sourceDigest,
      "Source adjudication changed",
    );
    equal(
      sorted(linked.map((c) => c.citationId)),
      sorted(approved.citationIds),
      "Missing or extra conflicts",
    );
    equal(
      sorted(linked.filter((c) => c.id !== source.id).map((c) => c.citationId)),
      sorted(approved.targetCitationIds),
      "Target allowlist changed",
    );
    const sourceResults = results.filter(
      (r) => r.citationId === source.citationId,
    );
    if (
      sourceResults.length !== 1 ||
      sourceResults[0]!.outcome !== "INCLUDE" ||
      sourceResults[0]!.resolvedVia !== "ADJUDICATION"
    )
      throw new Error("Source result changed");
    const { adjudication: _sourceAdjudication, ...sourceConflict } = source;
    equal(
      transferDigest(sourceConflict),
      approved.sourceConflictDigest,
      "Source conflict changed",
    );
    equal(
      transferDigest(sourceResults[0]),
      approved.sourceResultDigest,
      "Source result changed",
    );
    const before = {
      sharedDigest,
      citations: citations.filter((c) => approved.citationIds.includes(c.id)),
      decisions: decisions.filter(has),
      assignments: assignments.filter(has),
      conflicts: linked,
      results: results.filter(has),
      downstream,
    };
    return { approved, source, before, digest: transferDigest(before) };
  });
  return { context, sharedDigest, groups };
}
export type IncludeTransferPlan = {
  manifestDigest: string;
  batchId: string;
  groupDigests: string[];
  digest: string;
};
function planFor(
  m: IncludeTransferManifest,
  state: Awaited<ReturnType<typeof readState>>,
): IncludeTransferPlan {
  const value = {
    manifestDigest: transferDigest(m),
    batchId: m.batchId,
    groupDigests: state.groups.map((g) => g.digest),
  };
  return { ...value, digest: transferDigest(value) };
}
function assertOpen(state: Awaited<ReturnType<typeof readState>>) {
  for (const g of state.groups)
    for (const c of g.before.conflicts.filter((c) =>
      g.approved.targetCitationIds.includes(c.citationId),
    )) {
      if (
        c.status !== "OPEN" ||
        c.adjudication ||
        c.resolvedAt ||
        g.before.results.some((r) => r.citationId === c.citationId)
      )
        throw new Error("Target is not an untouched open conflict");
    }
}
export async function dryRunIncludeTransfer(
  actorId: string,
  manifest: unknown,
) {
  const m = validateManifest(manifest);
  return locked(m, actorId, async (_tx, state) => {
    assertOpen(state);
    return planFor(m, state);
  });
}
export async function applyIncludeTransfer(
  actorId: string,
  manifest: unknown,
  approvedPlan: IncludeTransferPlan,
  backup: (before: unknown) => Promise<{ sha256: string; location: string }>,
) {
  const m = validateManifest(manifest);
  if (
    approvedPlan.manifestDigest !== transferDigest(m) ||
    approvedPlan.digest !==
      transferDigest({
        manifestDigest: approvedPlan.manifestDigest,
        batchId: approvedPlan.batchId,
        groupDigests: approvedPlan.groupDigests,
      })
  )
    throw new Error("Invalid approved plan");
  return locked(m, actorId, async (tx, state) => {
    const markerId = transferRowId(m.batchId, "batch", m.poolId);
    if (
      await tx.auditEvent.findUnique({
        where: { id: transferRowId(m.batchId, "rollback", m.poolId) },
      })
    )
      throw new Error(
        "Batch has been rolled back; a new reviewed batch is required",
      );
    const marker = await tx.auditEvent.findUnique({ where: { id: markerId } });
    if (marker) {
      const payload = marker.newValue as {
        planDigest?: string;
        postDigest?: string;
      };
      if (
        payload.planDigest !== approvedPlan.digest ||
        payload.postDigest !== transferDigest(state.groups.map((g) => g.before))
      )
        throw new Error(
          "Previously applied batch has changed; do not retry or roll back blindly",
        );
      return { alreadyApplied: true, targets: m.expectedTargets };
    }
    assertOpen(state);
    equal(
      planFor(m, state),
      approvedPlan,
      "Preconditions changed since reviewed dry run",
    );
    const beforeImage = {
      version: 1,
      manifest: m,
      plan: approvedPlan,
      actorId,
      capturedAt: new Date(),
      groups: state.groups.map((g) => g.before),
    };
    // Must durably complete BEFORE first DB mutation; callback failure aborts everything.
    const receipt = await backup(beforeImage);
    if (
      !/^[a-f0-9]{64}$/.test(receipt.sha256) ||
      receipt.sha256 !== transferDigest(beforeImage) ||
      !receipt.location
    )
      throw new Error("Backup acknowledgement invalid");
    const migratedAt = new Date();
    const adjudications: Prisma.ScreeningAdjudicationCreateManyInput[] = [];
    const results: Prisma.CitationStageResultCreateManyInput[] = [];
    const audits: Prisma.AuditEventCreateManyInput[] = [];
    for (const g of state.groups)
      for (const c of g.before.conflicts.filter((c) =>
        g.approved.targetCitationIds.includes(c.citationId),
      )) {
        const source = g.source.adjudication!;
        const effectiveAt = g.source.resolvedAt;
        if (!effectiveAt)
          throw new Error("Source effective decision time is missing");
        const adjudication: Prisma.ScreeningAdjudicationCreateManyInput = {
          id: transferRowId(m.batchId, "adjudication", c.citationId),
          conflictId: c.id,
          adjudicatorId: source.adjudicatorId,
          finalDecision: "INCLUDE",
          exclusionReasonId: null,
          reason: source.reason,
          createdAt: effectiveAt,
        };
        adjudications.push(adjudication);
        const result: Prisma.CitationStageResultCreateManyInput = {
          id: transferRowId(m.batchId, "result", c.citationId),
          stageId: c.stageId,
          citationId: c.citationId,
          outcome: "INCLUDE",
          resolvedVia: "ADJUDICATION",
          resolvedAt: g.before.results.find(
            (r) => r.citationId === g.source.citationId,
          )!.resolvedAt,
        };
        results.push(result);
        audits.push({
          id: transferRowId(m.batchId, "audit", c.citationId),
          projectId: g.before.citations.find((x) => x.id === c.citationId)!
            .projectId,
          userId: actorId,
          entityType: "ScreeningAdjudication",
          entityId: adjudication.id!,
          action: "screening.conflict.adjudicated",
          previousValue: json(c),
          newValue: json({ ...adjudication, effectiveAt, result }),
          metadata: json({
            batchId: m.batchId,
            sourceAdjudicationId: source.id,
            sourceAdjudicatorId: source.adjudicatorId,
            sourceDecisionAt: effectiveAt,
            sourceRowCreatedAt: source.createdAt,
            migratedAt,
            pooledGuidelineId: m.guidelineId,
            pooledScreeningPoolId: m.poolId,
            pooledCitationIds: g.approved.citationIds,
            pooledProjectIds: g.before.citations.map((x) => x.projectId),
            backup: receipt,
            preconditionDigest: g.digest,
          }),
        });
        audits.push({
          id: transferRowId(m.batchId, "result-audit", c.citationId),
          projectId: g.before.citations.find((x) => x.id === c.citationId)!
            .projectId,
          userId: actorId,
          entityType: "CitationStageResult",
          entityId: result.id!,
          action: "screening.result.created",
          newValue: json(result),
          metadata: json({
            batchId: m.batchId,
            sourceAdjudicationId: source.id,
            sourceDecisionAt: effectiveAt,
            migratedAt,
          }),
        });
      }
    await tx.screeningAdjudication.createMany({ data: adjudications });
    await tx.citationStageResult.createMany({ data: results });
    for (const g of state.groups) {
      const updated = await tx.screeningConflict.updateMany({
        where: {
          id: {
            in: g.before.conflicts
              .filter((c) =>
                g.approved.targetCitationIds.includes(c.citationId),
              )
              .map((c) => c.id),
          },
          status: "OPEN",
        },
        data: { status: "RESOLVED", resolvedAt: g.source.resolvedAt },
      });
      if (updated.count !== g.approved.targetCitationIds.length)
        throw new Error("Conflict write count changed");
    }
    await tx.auditEvent.createMany({ data: audits });
    const after = await readState(tx, m, state.context);
    for (let i = 0; i < state.groups.length; i++) {
      const before = state.groups[i]!,
        post = after.groups[i]!;
      equal(
        before.before.decisions,
        post.before.decisions,
        "Reviewer history changed",
      );
      equal(
        before.before.assignments,
        post.before.assignments,
        "Assignments changed",
      );
      equal(before.source, post.source, "Source changed");
      for (const c of post.before.conflicts)
        if (
          c.status !== "RESOLVED" ||
          c.adjudication?.finalDecision !== "INCLUDE" ||
          c.adjudication.reason !== post.source.adjudication!.reason ||
          c.adjudication.adjudicatorId !== m.sourceAdjudicatorId
        )
          throw new Error("Post-write verification failed");
      if (
        post.before.results.length !== post.approved.citationIds.length ||
        post.before.results.some(
          (r) => r.outcome !== "INCLUDE" || r.resolvedVia !== "ADJUDICATION",
        )
      )
        throw new Error("Result verification failed");
    }
    await tx.auditEvent.create({
      data: {
        id: markerId,
        projectId: m.guidelineId,
        userId: actorId,
        entityType: "HistoricalIncludeTransfer",
        entityId: m.batchId,
        action: "SCREENING_HISTORICAL_INCLUDE_BATCH",
        newValue: json({
          planDigest: approvedPlan.digest,
          postDigest: transferDigest(after.groups.map((g) => g.before)),
          targets: m.expectedTargets,
        }),
        metadata: json({
          backup: receipt,
          migratedAt,
          manifestDigest: transferDigest(m),
        }),
      },
    });
    return { alreadyApplied: false, targets: m.expectedTargets };
  });
}

/** Explicit compensation only. Never called automatically after an uncertain commit. */
export async function rollbackIncludeTransfer(
  actorId: string,
  manifest: unknown,
  approvedPlan: IncludeTransferPlan,
  backupImage: unknown,
) {
  const m = validateManifest(manifest);
  return locked(m, actorId, async (tx, state) => {
    const marker = await tx.auditEvent.findUniqueOrThrow({
      where: { id: transferRowId(m.batchId, "batch", m.poolId) },
    });
    const metadata = marker.metadata as { backup: { sha256: string } };
    const payload = marker.newValue as {
      planDigest: string;
      postDigest: string;
    };
    if (
      marker.userId !== actorId ||
      transferDigest(backupImage) !== metadata.backup.sha256 ||
      payload.planDigest !== approvedPlan.digest
    )
      throw new Error(
        "Rollback approval/actor/backup does not match applied batch",
      );
    const rollbackId = transferRowId(m.batchId, "rollback", m.poolId);
    const previousRollback = await tx.auditEvent.findUnique({
      where: { id: rollbackId },
    });
    if (previousRollback) {
      equal(
        planFor(m, state),
        approvedPlan,
        "Rolled-back state has since changed",
      );
      return { alreadyRolledBack: true, targets: m.expectedTargets };
    }
    if (
      payload.postDigest !== transferDigest(state.groups.map((g) => g.before))
    )
      throw new Error(
        "Applied data, authority, corpus or downstream work changed; manual compensating review required",
      );
    for (const g of state.groups)
      for (const c of g.before.conflicts.filter((c) =>
        g.approved.targetCitationIds.includes(c.citationId),
      )) {
        const adjudicationId = transferRowId(
          m.batchId,
          "adjudication",
          c.citationId,
        );
        const resultId = transferRowId(m.batchId, "result", c.citationId);
        if (
          c.adjudication?.id !== adjudicationId ||
          !g.before.results.some((r) => r.id === resultId)
        )
          throw new Error("Target no longer belongs to migration");
        await tx.auditEvent.create({
          data: {
            id: transferRowId(m.batchId, "rollback-audit", c.citationId),
            projectId: g.before.citations.find((x) => x.id === c.citationId)!
              .projectId,
            userId: actorId,
            entityType: "ScreeningAdjudication",
            entityId: adjudicationId,
            action: "screening.historical_include_transfer.rolled_back",
            previousValue: json({
              conflict: c,
              result: g.before.results.find((r) => r.id === resultId),
            }),
            metadata: json({
              batchId: m.batchId,
              sourceAdjudicationId: g.source.adjudication!.id,
              backupSha256: metadata.backup.sha256,
            }),
          },
        });
        await tx.citationStageResult.delete({ where: { id: resultId } });
        await tx.screeningAdjudication.delete({
          where: { id: adjudicationId },
        });
        await tx.screeningConflict.update({
          where: { id: c.id },
          data: { status: "OPEN", resolvedAt: null },
        });
      }
    const restored = await readState(tx, m, state.context);
    equal(
      planFor(m, restored),
      approvedPlan,
      "Rollback failed exact before-state verification",
    );
    await tx.auditEvent.create({
      data: {
        id: rollbackId,
        projectId: m.guidelineId,
        userId: actorId,
        entityType: "HistoricalIncludeTransfer",
        entityId: m.batchId,
        action: "screening.historical_include_batch.rolled_back",
        metadata: json({
          planDigest: approvedPlan.digest,
          backupSha256: metadata.backup.sha256,
        }),
      },
    });
    return { alreadyRolledBack: false, targets: m.expectedTargets };
  });
}
