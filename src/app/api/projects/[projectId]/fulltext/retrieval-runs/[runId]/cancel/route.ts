import { handleRoute, ok } from "@/server/api-utils";
import { getCtx } from "@/server/auth/session";
import { cancelRetrievalRun } from "@/server/services/fulltext-retrieval";

type Params = { params: Promise<{ projectId: string; runId: string }> };

export async function POST(_req: Request, { params }: Params) {
  return handleRoute(async () => {
    const ctx = await getCtx();
    const { projectId, runId } = await params;
    return ok(await cancelRetrievalRun(ctx, projectId, runId));
  });
}
