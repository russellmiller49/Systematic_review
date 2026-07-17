import { handleRoute, ok } from "@/server/api-utils";
import { getCtx } from "@/server/auth/session";
import { markReviewed } from "@/server/services/grade";

type Params = { params: Promise<{ projectId: string; outcomeId: string }> };

export async function POST(_req: Request, { params }: Params) {
  return handleRoute(async () => {
    const ctx = await getCtx();
    const { projectId, outcomeId } = await params;
    return ok(await markReviewed(ctx, projectId, outcomeId));
  });
}
