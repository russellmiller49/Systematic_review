// Read the existing dedup decisions as study evidence; never copy them into a second store.
import type { Tx } from "@/server/db";
import type { Ctx } from "@/server/auth/session";
import { invalidState } from "@/server/errors";
import * as audit from "@/server/services/audit";
import { AuditActions } from "@/server/services/audit";
import { mergeStudies } from "./reconcile";
import { studyLabelFor } from "./index";

export function projectCompanionGraph(
  citations: { id: string; status: string; duplicateOfId: string | null }[],
  decisions: { id: string; citationAId: string; citationBId: string }[],
) {
  const byId = new Map(citations.map((c) => [c.id, c]));
  const root = (id: string): string | null => {
    const seen = new Set<string>();
    while (!seen.has(id)) {
      seen.add(id);
      const c = byId.get(id);
      if (!c) return null;
      if (c.status === "ACTIVE") return c.id;
      if (!c.duplicateOfId) return null;
      id = c.duplicateOfId;
    }
    return null;
  };
  const edges = decisions.flatMap((d) => {
    const a = root(d.citationAId),
      b = root(d.citationBId);
    return a && b ? [{ ...d, a, b }] : [];
  });
  const neighbors = new Map<string, Set<string>>();
  for (const { a, b } of edges) {
    if (!neighbors.has(a)) neighbors.set(a, new Set());
    if (!neighbors.has(b)) neighbors.set(b, new Set());
    neighbors.get(a)!.add(b);
    neighbors.get(b)!.add(a);
  }
  const components = new Map<string, Set<string>>();
  for (const id of neighbors.keys()) {
    if (components.has(id)) continue;
    const members = new Set([id]);
    for (const member of members)
      for (const next of neighbors.get(member) ?? []) members.add(next);
    for (const member of members) components.set(member, members);
  }
  return {
    edges,
    root,
    members: (id: string) => components.get(root(id) ?? id) ?? new Set([id]),
    sameStudy: (a: string, b: string) => components.get(a)?.has(b) ?? false,
    // Shared study membership does not prove that two imported copies are separate
    // publications. Only an explicit judgment between their current roots blocks
    // deduplication; keep the historical decision endpoints untouched.
    hasDirectConflict: (ids: Iterable<string>) => {
      const roots = new Set([...ids].map(root).filter((id) => id !== null));
      return edges.some(({ a, b }) => a !== b && roots.has(a) && roots.has(b));
    },
  };
}

export async function companionGraph(tx: Tx, projectId: string) {
  const decisions = await tx.deduplicationCandidate.findMany({
    where: {
      projectId,
      status: "COMPANION",
      citationA: { projectId },
      citationB: { projectId },
    },
    select: { id: true, citationAId: true, citationBId: true },
  });
  const citations = decisions.length
    ? await tx.citation.findMany({
        where: { projectId },
        select: { id: true, status: true, duplicateOfId: true },
      })
    : [];
  return projectCompanionGraph(citations, decisions);
}

// Called only while holding the same project lock as dedup and all study membership writes.
// Inclusion remains the gate: even an excluded intermediate node can carry the judgment,
// but only ACTIVE FT-included reports receive analysis links.
export async function reconcileIncludedCompanions(
  tx: Tx,
  ctx: Ctx,
  projectId: string,
  citationId: string,
) {
  const graph = await companionGraph(tx, projectId);
  const members = graph.members(citationId);
  const eligible = await tx.citation.findMany({
    where: {
      projectId,
      id: { in: [...members] },
      status: "ACTIVE",
      stageResults: {
        some: { stage: { projectId, type: "FULL_TEXT" }, outcome: "INCLUDE" },
      },
    },
    include: { studyLinks: { include: { study: true } } },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
  });
  if (!eligible.length) return null;
  if (
    eligible.some(
      (c) =>
        c.studyLinks.length > 1 ||
        c.studyLinks.some((l) => l.study.projectId !== projectId),
    )
  ) {
    throw invalidState(
      "Reports have ambiguous study membership. Reconcile them in the companion/study workflow first.",
    );
  }
  const studies = [
    ...new Map(
      eligible.flatMap((c) =>
        c.studyLinks.map((l) => [l.studyId, l.study] as const),
      ),
    ).values(),
  ].sort(
    (a, b) =>
      a.createdAt.getTime() - b.createdAt.getTime() || a.id.localeCompare(b.id),
  );
  let study = studies[0];
  if (!study) {
    const primary = eligible[0]!;
    study = await tx.study.create({
      data: {
        projectId,
        label: studyLabelFor(primary),
        createdById: ctx.userId,
      },
    });
    await audit.record(tx, {
      projectId,
      userId: ctx.userId,
      entityType: "Study",
      entityId: study.id,
      action: AuditActions.STUDY_CREATED,
      newValue: {
        label: study.label,
        citationId: primary.id,
        autoCreated: true,
      },
    });
  }
  for (const source of studies.slice(1))
    await mergeStudies(tx, ctx, projectId, source.id, study.id);
  const decisionIds = graph.edges
    .filter((e) => members.has(e.a))
    .map((e) => e.id);
  const existing = await tx.studyReportLink.findMany({
    where: { studyId: study.id },
  });
  const linkedIds = new Set(existing.map((l) => l.citationId));
  let hasPrimary = existing.some((l) => l.isPrimaryReport);
  for (const c of eligible) {
    if (linkedIds.has(c.id)) continue;
    const link = await tx.studyReportLink.create({
      data: {
        studyId: study.id,
        citationId: c.id,
        isPrimaryReport: !hasPrimary,
      },
    });
    hasPrimary = true;
    await audit.record(tx, {
      projectId,
      userId: ctx.userId,
      entityType: "StudyReportLink",
      entityId: link.id,
      action: AuditActions.STUDY_REPORT_LINKED,
      newValue: {
        studyId: study.id,
        citationId: c.id,
        isPrimaryReport: link.isPrimaryReport,
      },
      metadata: { dedupCompanionIds: decisionIds },
    });
  }
  // A durable dependency marker keeps undo safe even after later manual relinking.
  if (eligible.length > 1)
    for (const id of decisionIds) {
      const applied = await tx.auditEvent.findFirst({
        where: {
          projectId,
          entityType: "DeduplicationCandidate",
          entityId: id,
          action: AuditActions.DEDUP_COMPANION_APPLIED,
        },
      });
      if (!applied)
        await audit.record(tx, {
          projectId,
          userId: ctx.userId,
          entityType: "DeduplicationCandidate",
          entityId: id,
          action: AuditActions.DEDUP_COMPANION_APPLIED,
          metadata: {
            studyId: study.id,
            citationIds: eligible.map((c) => c.id),
          },
        });
    }
  return study;
}
