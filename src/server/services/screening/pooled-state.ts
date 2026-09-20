import type { Prisma } from "@prisma/client";
import type { Tx } from "@/server/db";
import { groupPooledCitationRows } from "./grouping";

// Load identity and screening state in bulk. Full citation text is fetched only for a
// navigator page. This same classifier gates writes after the stage locks are acquired.
export const pooledIdentitySelect = {
  id: true,
  projectId: true,
  doi: true,
  pmid: true,
  normalizedTitle: true,
  createdAt: true,
} satisfies Prisma.CitationSelect;

export async function loadPooledCitationGroups(db: Tx, projectIds: string[]) {
  return groupPooledCitationRows(
    await db.citation.findMany({
      where: { projectId: { in: projectIds }, status: "ACTIVE" },
      select: pooledIdentitySelect,
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    }),
  );
}

export type PooledCitationGroups = Awaited<
  ReturnType<typeof loadPooledCitationGroups>
>;

export async function loadPooledState(
  db: Tx,
  projectIds: string[],
  stageIds: string[],
  selectedGroups?: PooledCitationGroups,
) {
  const groups =
    selectedGroups ?? (await loadPooledCitationGroups(db, projectIds));
  const where = {
    stageId: { in: stageIds },
    ...(selectedGroups
      ? {
          citationId: { in: groups.flatMap((group) => group.map((c) => c.id)) },
        }
      : {}),
  };
  const [assignments, decisions, results, conflicts] = await Promise.all([
    db.screeningAssignment.findMany({
      where,
      select: { citationId: true, reviewerId: true, status: true },
    }),
    db.screeningDecision.findMany({
      where,
      select: {
        citationId: true,
        reviewerId: true,
        decision: true,
        notes: true,
        exclusionReason: { select: { label: true } },
      },
    }),
    db.citationStageResult.findMany({
      where,
      select: { citationId: true, outcome: true },
    }),
    db.screeningConflict.findMany({
      where: { ...where, status: "OPEN" },
      select: { citationId: true },
    }),
  ]);
  const byCitation = <T extends { citationId: string }>(rows: T[]) => {
    const map = new Map<string, T[]>();
    for (const row of rows) {
      const bucket = map.get(row.citationId) ?? [];
      bucket.push(row);
      map.set(row.citationId, bucket);
    }
    return map;
  };
  const assignmentsByCitation = byCitation(assignments);
  const decisionsByCitation = byCitation(decisions);
  const resultByCitation = new Map(
    results.map((r) => [r.citationId, r.outcome]),
  );
  const conflictIds = new Set(conflicts.map((c) => c.citationId));

  return groups.map((group) => {
    const rows = group.map((citation) => {
      const assignments = assignmentsByCitation.get(citation.id) ?? [];
      const decisions = decisionsByCitation.get(citation.id) ?? [];
      const liveDecisions = decisions.filter((d) =>
        assignments.some(
          (a) => a.reviewerId === d.reviewerId && a.status === "COMPLETED",
        ),
      );
      // Missing/partial decisions, different reviewer sets, notes/reasons, results or
      // conflict state are exceptional. Unequal PENDING coverage is perfectly normal.
      const invalid =
        assignments.some(
          (a) =>
            a.status === "COMPLETED" &&
            !decisions.some((d) => d.reviewerId === a.reviewerId),
        ) ||
        decisions.some(
          (d) =>
            assignments.find((a) => a.reviewerId === d.reviewerId)?.status !==
            "COMPLETED",
        );
      const signature = JSON.stringify({
        decisions: liveDecisions
          .map((d) => [
            d.reviewerId,
            d.decision,
            d.notes,
            d.exclusionReason?.label ?? null,
          ])
          .sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
        outcome: resultByCitation.get(citation.id) ?? null,
        conflict: conflictIds.has(citation.id),
      });
      return { assignments, decisions, liveDecisions, invalid, signature };
    });
    const needsSynchronization = rows.some(
      (row) => row.invalid || row.signature !== rows[0]!.signature,
    );
    const reviewedBy = new Set(
      rows.flatMap((row) => row.liveDecisions.map((d) => d.reviewerId)),
    );
    return {
      id: group.map((c) => c.id).sort()[0]!,
      group,
      rows,
      reviewedBy,
      needsSynchronization,
      finalOutcome: needsSynchronization
        ? null
        : (resultByCitation.get(group[0]!.id) ?? null),
    };
  });
}

export type PooledState = Awaited<ReturnType<typeof loadPooledState>>[number];

export function pooledReviewerState(
  state: PooledState,
  reviewerId: string,
  required: number,
  quota: { remaining: number } | null,
) {
  const myDecisions = state.rows.map((row) =>
    row.decisions.find((d) => d.reviewerId === reviewerId),
  );
  const hasReviewed = myDecisions.some(Boolean);
  const myDecision = myDecisions.find((d) => d !== undefined) ?? null;
  const voided = state.rows.some((row) =>
    row.assignments.some(
      (a) => a.reviewerId === reviewerId && a.status === "VOIDED",
    ),
  );
  const authorized = quota
    ? quota.remaining > 0
    : state.rows.every((row) =>
        row.assignments.some(
          (a) => a.reviewerId === reviewerId && a.status === "PENDING",
        ),
      );
  const unlocked =
    !state.needsSynchronization && !state.finalOutcome && !voided;
  return {
    hasReviewed,
    myDecision: myDecision
      ? { decision: myDecision.decision, notes: myDecision.notes }
      : null,
    available:
      unlocked &&
      !hasReviewed &&
      state.reviewedBy.size < required &&
      authorized,
    canRevise: unlocked && myDecisions.every(Boolean),
  };
}
