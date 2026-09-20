import type { Tx } from "@/server/db";
import { connectedComponents } from "./graph";

// All dedup graph mutations (including import rollback) acquire this before reading.
// The transaction-scoped row lock serializes detection/rejection/merge/undo per project.
// NO KEY UPDATE permits citation inserts taking foreign-key KEY SHARE locks.
export async function lockDedupProject(tx: Tx, projectId: string) {
  await tx.$queryRaw`SELECT "id" FROM "Project" WHERE "id" = ${projectId} FOR NO KEY UPDATE`;
}

// Caller supplies its transaction and holds lockDedupProject. Only SUGGESTED membership
// changes: decided rows and their group/audit references remain historical evidence.
export async function normalizeGroups(tx: Tx, projectId: string) {
  const suggested = await tx.deduplicationCandidate.findMany({
    where: { projectId, status: "SUGGESTED" },
    include: {
      citationA: { select: { projectId: true, status: true } },
      citationB: { select: { projectId: true, status: true } },
    },
    orderBy: { id: "asc" },
  });
  const groups = await tx.deduplicationGroup.findMany({ where: { projectId } });
  const groupsById = new Map(groups.map((group) => [group.id, group]));
  const valid = suggested.filter(
    (edge) =>
      edge.citationAId !== edge.citationBId &&
      edge.citationA.projectId === projectId &&
      edge.citationB.projectId === projectId &&
      edge.citationA.status === "ACTIVE" &&
      edge.citationB.status === "ACTIVE",
  );
  const validIds = new Set(valid.map((edge) => edge.id));
  const invalidIds = suggested.filter((edge) => !validIds.has(edge.id)).map((edge) => edge.id);
  if (invalidIds.length) {
    // Dormant suggestions can become applicable again after undo; don't invent decisions.
    await tx.deduplicationCandidate.updateMany({
      where: { projectId, id: { in: invalidIds }, status: "SUGGESTED" },
      data: { groupId: null },
    });
  }
  const used = new Set<string>();
  for (const component of connectedComponents(valid)) {
    const reuseId = component
      .map((edge) => edge.groupId)
      .find((id) => id !== null && groupsById.has(id) && !used.has(id));
    const groupId = reuseId ?? (await tx.deduplicationGroup.create({ data: { projectId } })).id;
    if (reuseId && groupsById.get(reuseId)?.status !== "OPEN") {
      await tx.deduplicationGroup.update({
        where: { id: groupId, projectId },
        data: { status: "OPEN" },
      });
    }
    used.add(groupId);
    const movedIds = component.filter((edge) => edge.groupId !== groupId).map((edge) => edge.id);
    if (movedIds.length) {
      await tx.deduplicationCandidate.updateMany({
        where: { projectId, id: { in: movedIds }, status: "SUGGESTED" },
        data: { groupId },
      });
    }
  }
  // Retain resolved groups: audit metadata may still reference them for undo.
  await tx.deduplicationGroup.updateMany({
    where: { projectId, status: "OPEN", id: { notIn: [...used] } },
    data: { status: "RESOLVED" },
  });
  return { groupsOpen: used.size };
}
