import { handleRoute, ok } from "@/server/api-utils";
import { getCtx } from "@/server/auth/session";
import { getBatch } from "@/server/services/imports";

// Next.js 15: params is a Promise.
type Params = { params: Promise<{ projectId: string; batchId: string }> };

export async function GET(_req: Request, { params }: Params) {
  return handleRoute(async () => {
    const ctx = await getCtx();
    const { projectId, batchId } = await params;
    return ok(await getBatch(ctx, projectId, batchId));
  });
}
