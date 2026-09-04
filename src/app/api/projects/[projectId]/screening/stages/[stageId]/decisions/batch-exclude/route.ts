import { created, handleRoute, parseBody } from "@/server/api-utils";
import { getCtx } from "@/server/auth/session";
import {
  batchExclude,
  batchExcludeSchema,
} from "@/server/services/screening";

type Params = { params: Promise<{ projectId: string; stageId: string }> };

export async function POST(req: Request, { params }: Params) {
  return handleRoute(async () => {
    const ctx = await getCtx();
    const { projectId, stageId } = await params;
    const input = await parseBody(req, batchExcludeSchema);
    return created(await batchExclude(ctx, projectId, stageId, input));
  });
}
