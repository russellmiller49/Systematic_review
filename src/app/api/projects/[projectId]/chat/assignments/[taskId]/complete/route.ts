import { handleRoute, ok } from "@/server/api-utils";
import { getCtx } from "@/server/auth/session";
import { completeAssignmentTask } from "@/server/services/chat";

type Params = { params: Promise<{ projectId: string; taskId: string }> };

export async function POST(_req: Request, { params }: Params) {
  return handleRoute(async () => {
    const ctx = await getCtx();
    const { projectId, taskId } = await params;
    return ok(await completeAssignmentTask(ctx, projectId, taskId));
  });
}
