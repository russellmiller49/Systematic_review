import { z } from "zod";
import type { AuditEvent, CitationStageResult } from "@prisma/client";
import { AuditActions } from "@/server/services/audit";
import { digest } from "./recovery-token";

// This is an exact, narrow provenance exception, not a general history bypass.
export const consensusSnapshotSchema = z.object({
  results: z
    .array(
      z.object({
        id: z.string(),
        stageId: z.string(),
        citationId: z.string(),
        outcome: z.literal("EXCLUDE"),
        resolvedVia: z.literal("CONSENSUS"),
        resolvedAt: z.string().datetime(),
        creationAuditId: z.string(),
        creationAuditFingerprint: z.string().length(64),
      }),
    )
    .min(1),
  coReviewerFingerprint: z.string().length(64),
  stagePolicyFingerprint: z.string().length(64),
});
export type ConsensusSnapshot = z.infer<typeof consensusSnapshotSchema>;
export type ResultAudit = Pick<
  AuditEvent,
  | "id"
  | "entityId"
  | "action"
  | "previousValue"
  | "newValue"
  | "metadata"
  | "reason"
  | "createdAt"
  | "userId"
> & { citationId: string };
const value = (v: unknown) =>
  v && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : null;

function creationMatches(
  a: ResultAudit,
  r: Omit<
    ConsensusSnapshot["results"][number],
    "creationAuditId" | "creationAuditFingerprint"
  >,
) {
  const next = value(a.newValue);
  return (
    a.entityId === r.id &&
    a.action === AuditActions.SCREENING_RESULT_CREATED &&
    a.previousValue === null &&
    next?.stageId === r.stageId &&
    next.citationId === r.citationId &&
    next.outcome === "EXCLUDE" &&
    next.resolvedVia === "CONSENSUS"
  );
}

export function verifiedConsensusSnapshot(
  results: CitationStageResult[],
  history: ResultAudit[],
  citationIds: string[],
  stageByCitation: Map<string, string>,
  coReviewerFingerprint: string,
  stagePolicyFingerprint: string,
  liveReviewers: Map<string, string[]>,
): ConsensusSnapshot | null {
  if (
    results.length !== citationIds.length ||
    history.length !== citationIds.length
  )
    return null;
  const snapshots = [];
  for (const citationId of citationIds) {
    const result = results.find((r) => r.citationId === citationId);
    const events = history.filter((a) => a.citationId === citationId);
    if (
      !result ||
      result.stageId !== stageByCitation.get(citationId) ||
      result.outcome !== "EXCLUDE" ||
      result.resolvedVia !== "CONSENSUS" ||
      events.length !== 1
    )
      return null;
    const snapshot = {
      ...result,
      outcome: "EXCLUDE" as const,
      resolvedVia: "CONSENSUS" as const,
      resolvedAt: result.resolvedAt.toISOString(),
    };
    if (
      !creationMatches(events[0]!, snapshot) ||
      events[0]!.createdAt.getTime() < result.resolvedAt.getTime() ||
      !liveReviewers.get(citationId)?.includes(events[0]!.userId)
    )
      return null;
    snapshots.push({
      ...snapshot,
      creationAuditId: events[0]!.id,
      creationAuditFingerprint: digest(events[0]),
    });
  }
  return { results: snapshots, coReviewerFingerprint, stagePolicyFingerprint };
}

export function verifiedConsensusRestorationHistory(
  snapshot: ConsensusSnapshot,
  history: ResultAudit[],
  withdrawalId: string,
) {
  if (history.length !== snapshot.results.length * 2) return false;
  return snapshot.results.every((r) => {
    const events = history.filter((a) => a.citationId === r.citationId);
    const creation = events.find((a) => a.id === r.creationAuditId);
    const reopened = events.find(
      (a) => a.action === AuditActions.SCREENING_RESULT_REOPENED,
    );
    if (
      events.length !== 2 ||
      !creation ||
      !creationMatches(creation, r) ||
      digest(creation) !== r.creationAuditFingerprint ||
      !reopened ||
      reopened.entityId !== r.id ||
      value(reopened.metadata)?.withdrawalId !== withdrawalId ||
      reopened.newValue !== null
    )
      return false;
    const { creationAuditId: _, creationAuditFingerprint: __, ...original } = r;
    const previous = consensusSnapshotSchema.shape.results.element
      .omit({ creationAuditId: true, creationAuditFingerprint: true })
      .strict()
      .safeParse(reopened.previousValue);
    // PostgreSQL JSONB key order differs from the parsed manifest's schema order.
    return previous.success && digest(previous.data) === digest(original);
  });
}
