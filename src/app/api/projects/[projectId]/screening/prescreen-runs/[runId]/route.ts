import { handleRoute, ok } from "@/server/api-utils";
import { getCtx } from "@/server/auth/session";
import { getRun } from "@/server/services/ai-screening";

type Params = { params: Promise<{ projectId: string; runId: string }> };

export async function GET(_req: Request, { params }: Params) {
  return handleRoute(async () => {
    const ctx = await getCtx();
    const { projectId, runId } = await params;
    return ok(await getRun(ctx, projectId, runId));
  });
}
