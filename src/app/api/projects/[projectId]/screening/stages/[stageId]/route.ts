import { handleRoute, ok, parseBody } from "@/server/api-utils";
import { getCtx } from "@/server/auth/session";
import { updateStage, updateStageSchema } from "@/server/services/screening";

type Params = { params: Promise<{ projectId: string; stageId: string }> };

export async function PATCH(req: Request, { params }: Params) {
  return handleRoute(async () => {
    const ctx = await getCtx();
    const { projectId, stageId } = await params;
    const input = await parseBody(req, updateStageSchema);
    return ok(await updateStage(ctx, projectId, stageId, input));
  });
}
