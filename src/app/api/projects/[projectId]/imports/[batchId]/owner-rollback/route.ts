import { handleRoute, ok, parseBody } from "@/server/api-utils";
import { getCtx } from "@/server/auth/session";
import {
  ownerDeleteBatchSchema,
  ownerDeleteBatchWithScreeningHistory,
} from "@/server/services/imports";

type Params = { params: Promise<{ projectId: string; batchId: string }> };

export async function POST(req: Request, { params }: Params) {
  return handleRoute(async () => {
    const ctx = await getCtx();
    const { projectId, batchId } = await params;
    const input = await parseBody(req, ownerDeleteBatchSchema);
    return ok(await ownerDeleteBatchWithScreeningHistory(ctx, projectId, batchId, input));
  });
}
