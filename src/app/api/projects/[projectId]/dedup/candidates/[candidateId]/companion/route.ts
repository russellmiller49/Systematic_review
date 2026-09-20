import { handleRoute, ok } from "@/server/api-utils";
import { getCtx } from "@/server/auth/session";
import { confirmCompanions } from "@/server/services/dedup";
type Params = { params: Promise<{ projectId: string; candidateId: string }> };
export async function POST(_req: Request, { params }: Params) {
  return handleRoute(async () => {
    const ctx = await getCtx();
    const { projectId, candidateId } = await params;
    return ok(await confirmCompanions(ctx, projectId, { candidateId }));
  });
}
