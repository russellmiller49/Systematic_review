import { created, handleRoute, ok, parseBody } from "@/server/api-utils";
import { getCtx } from "@/server/auth/session";
import {
  listRetrievalRuns,
  startRetrievalRun,
  startRetrievalRunSchema,
} from "@/server/services/fulltext-retrieval";

type Params = { params: Promise<{ projectId: string }> };

export async function GET(_req: Request, { params }: Params) {
  return handleRoute(async () => {
    const ctx = await getCtx();
    const { projectId } = await params;
    return ok(await listRetrievalRuns(ctx, projectId));
  });
}

export async function POST(req: Request, { params }: Params) {
  return handleRoute(async () => {
    const ctx = await getCtx();
    const { projectId } = await params;
    const input = await parseBody(req, startRetrievalRunSchema);
    return created(await startRetrievalRun(ctx, projectId, input));
  });
}
