import { created, handleRoute, ok, parseBody } from "@/server/api-utils";
import { getCtx } from "@/server/auth/session";
import {
  createPooledDecision,
  createPooledDecisionSchema,
  getPooledQueue,
  pooledSelectionSchema,
} from "@/server/services/screening/pooled";

type Params = { params: Promise<{ projectId: string }> };

export async function GET(req: Request, { params }: Params) {
  return handleRoute(async () => {
    const ctx = await getCtx();
    const { projectId } = await params;
    const projectIds = new URL(req.url).searchParams.getAll("projectId");
    const input = pooledSelectionSchema.parse({ projectIds });
    return ok(await getPooledQueue(ctx, projectId, input));
  });
}
export async function POST(req: Request, { params }: Params) {
  return handleRoute(async () => {
    const ctx = await getCtx();
    const { projectId } = await params;
    const input = await parseBody(req, createPooledDecisionSchema);
    return created(await createPooledDecision(ctx, projectId, input));
  });
}
