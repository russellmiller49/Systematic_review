import { handleRoute, ok, parseBody } from "@/server/api-utils";
import { getCtx } from "@/server/auth/session";
import { putJudgment, putJudgmentSchema } from "@/server/services/rob";

type Params = { params: Promise<{ projectId: string; assessmentId: string; domainId: string }> };

export async function PUT(req: Request, { params }: Params) {
  return handleRoute(async () => {
    const ctx = await getCtx();
    const { projectId, assessmentId, domainId } = await params;
    const input = await parseBody(req, putJudgmentSchema);
    return ok(await putJudgment(ctx, projectId, assessmentId, domainId, input));
  });
}
