import { handleRoute, ok } from "@/server/api-utils";
import { getCtx } from "@/server/auth/session";
import { publishTool } from "@/server/services/rob";

type Params = { params: Promise<{ projectId: string; toolId: string }> };

export async function POST(_req: Request, { params }: Params) {
  return handleRoute(async () => {
    const ctx = await getCtx();
    const { projectId, toolId } = await params;
    return ok(await publishTool(ctx, projectId, toolId));
  });
}
