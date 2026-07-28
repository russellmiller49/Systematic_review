import { handleRoute, ok } from "@/server/api-utils";
import { getCtx } from "@/server/auth/session";
import { getQueue, queueQuerySchema } from "@/server/services/screening";

type Params = { params: Promise<{ projectId: string; stageId: string }> };

export async function GET(req: Request, { params }: Params) {
  return handleRoute(async () => {
    const ctx = await getCtx();
    const { projectId, stageId } = await params;
    const query = queueQuerySchema.parse(Object.fromEntries(new URL(req.url).searchParams));
    return ok(await getQueue(ctx, projectId, stageId, query));
  });
}
