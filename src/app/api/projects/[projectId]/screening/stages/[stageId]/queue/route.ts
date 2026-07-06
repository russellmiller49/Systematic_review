import { handleRoute, ok } from "@/server/api-utils";
import { getCtx } from "@/server/auth/session";
import { getQueue } from "@/server/services/screening";

type Params = { params: Promise<{ projectId: string; stageId: string }> };

export async function GET(_req: Request, { params }: Params) {
  return handleRoute(async () => {
    const ctx = await getCtx();
    const { projectId, stageId } = await params;
    return ok(await getQueue(ctx, projectId, stageId));
  });
}
