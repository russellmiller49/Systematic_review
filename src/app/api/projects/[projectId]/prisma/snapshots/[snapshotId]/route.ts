import { handleRoute, ok } from "@/server/api-utils";
import { getCtx } from "@/server/auth/session";
import { getPrismaSnapshot } from "@/server/services/prisma-report";

// Next.js 15: params is a Promise.
type Params = { params: Promise<{ projectId: string; snapshotId: string }> };

export async function GET(_req: Request, { params }: Params) {
  return handleRoute(async () => {
    const ctx = await getCtx();
    const { projectId, snapshotId } = await params;
    return ok(await getPrismaSnapshot(ctx, projectId, snapshotId));
  });
}
