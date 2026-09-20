import { created, handleRoute, ok, parseBody } from "@/server/api-utils";
import { getCtx } from "@/server/auth/session";
import {
  createPooledDecision,
  createPooledDecisionSchema,
  getPooledQueue,
  pooledNavigatorQuerySchema,
} from "@/server/services/screening/pooled";

type Params = { params: Promise<{ projectId: string }> };

export async function GET(req: Request, { params }: Params) {
  return handleRoute(async () => {
    const ctx = await getCtx();
    const { projectId } = await params;
    const input = pooledNavigatorQuerySchema.parse(
      Object.fromEntries(new URL(req.url).searchParams),
    );
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
