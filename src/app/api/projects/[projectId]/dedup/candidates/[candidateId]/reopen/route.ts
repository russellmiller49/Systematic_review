import { handleRoute, ok } from "@/server/api-utils";
import { getCtx } from "@/server/auth/session";
import { reopenDecision } from "@/server/services/dedup";
type Params = { params: Promise<{ projectId: string; candidateId: string }> };
export async function POST(_req: Request, { params }: Params) {
  return handleRoute(async () => {
    const ctx = await getCtx();
    const { projectId, candidateId } = await params;
    return ok(await reopenDecision(ctx, projectId, candidateId));
  });
}
