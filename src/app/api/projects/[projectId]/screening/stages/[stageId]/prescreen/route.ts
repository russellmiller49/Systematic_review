import { created, handleRoute, ok, parseBody } from "@/server/api-utils";
import { getCtx } from "@/server/auth/session";
import {
  listRuns,
  startPrescreenRun,
  startPrescreenSchema,
} from "@/server/services/ai-screening";

type Params = { params: Promise<{ projectId: string; stageId: string }> };

export async function GET(_req: Request, { params }: Params) {
  return handleRoute(async () => {
    const ctx = await getCtx();
    const { projectId, stageId } = await params;
    return ok(await listRuns(ctx, projectId, stageId));
  });
}

export async function POST(req: Request, { params }: Params) {
  return handleRoute(async () => {
    const ctx = await getCtx();
    const { projectId, stageId } = await params;
    const input = await parseBody(req, startPrescreenSchema);
    return created(await startPrescreenRun(ctx, projectId, stageId, input));
  });
}
