import { Prisma } from "@prisma/client";
import type { Tx } from "@/server/db";

const held = Symbol("pooled decision locks");
export type PooledDecisionLocks = {
  readonly [held]: true;
  readonly poolId: string;
  readonly stageIds: ReadonlySet<string>;
  readonly citationIds: ReadonlySet<string>;
};

// Shared guards exclude corpus/configuration changes but allow other pooled decisions.
// A quota row serializes one reviewer's budget; citation rows serialize one abstract.
// Every caller takes locks in this order. Do not upgrade a shared stage guard in the
// per-citation writer: two independent pooled submissions would deadlock on that upgrade.
export async function lockPooledDecision(
  tx: Tx,
  input: {
    projectIds: string[];
    stageIds: string[];
    citationIds: string[];
    poolId: string;
    reviewerId: string;
  },
): Promise<PooledDecisionLocks> {
  for (const id of [...new Set(input.projectIds)].sort()) {
    await tx.$queryRaw`SELECT "id" FROM "Project" WHERE "id" = ${id} FOR SHARE`;
  }
  for (const id of [...new Set(input.stageIds)].sort()) {
    await tx.$queryRaw`SELECT "id" FROM "ScreeningStage" WHERE "id" = ${id} FOR SHARE`;
  }
  await tx.$queryRaw`SELECT "id" FROM "ScreeningQuota" WHERE "poolId" = ${input.poolId} AND "reviewerId" = ${input.reviewerId} FOR UPDATE`;
  await tx.$queryRaw(Prisma.sql`
    SELECT "id" FROM "Citation" WHERE "id" IN (${Prisma.join(input.citationIds)})
    AND "projectId" IN (${Prisma.join(input.projectIds)}) ORDER BY "id" FOR UPDATE
  `);
  return {
    [held]: true,
    poolId: input.poolId,
    stageIds: new Set(input.stageIds),
    citationIds: new Set(input.citationIds),
  };
}
