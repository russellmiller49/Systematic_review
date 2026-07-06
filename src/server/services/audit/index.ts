import type { Prisma } from "@prisma/client";
import type { Tx } from "@/server/db";
import type { AuditAction } from "./actions";

export { AuditActions, ALL_AUDIT_ACTIONS, type AuditAction } from "./actions";

export interface AuditInput {
  projectId?: string | null;
  userId: string;
  entityType: string;
  entityId: string;
  action: AuditAction;
  previousValue?: unknown;
  newValue?: unknown;
  reason?: string | null;
  metadata?: Record<string, unknown>;
}

// THE audit rule: called with the SAME transaction client as the mutation it records,
// so a mutation can never commit without its audit event. Append-only — there is no
// update/delete path for audit rows anywhere in the codebase.
export async function record(tx: Tx, input: AuditInput): Promise<void> {
  await tx.auditEvent.create({
    data: {
      projectId: input.projectId ?? null,
      userId: input.userId,
      entityType: input.entityType,
      entityId: input.entityId,
      action: input.action,
      previousValue: toJson(input.previousValue),
      newValue: toJson(input.newValue),
      reason: input.reason ?? null,
      metadata: toJson(input.metadata),
    },
  });
}

function toJson(value: unknown): Prisma.InputJsonValue | undefined {
  if (value === undefined || value === null) return undefined;
  // Round-trip strips undefineds/Dates into JSON-safe values.
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
}
