import type { Tx } from "@/server/db";

// Evidence/protocol writers use the same project row as pooled screening's SHARE
// guard, before taking any child locks. NO KEY UPDATE permits foreign-key checks
// while excluding adjudication snapshot validation through commit.
export async function lockScreeningContextProject(tx: Tx, projectId: string) {
  await tx.$queryRaw`SELECT "id" FROM "Project" WHERE "id" = ${projectId} FOR NO KEY UPDATE`;
}
