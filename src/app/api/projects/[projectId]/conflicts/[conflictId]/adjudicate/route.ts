import { handleRoute, ok, parseBody } from "@/server/api-utils";
import { getCtx } from "@/server/auth/session";
import { adjudicateConflict, adjudicateSchema } from "@/server/services/screening";

type Params = { params: Promise<{ projectId: string; conflictId: string }> };

export async function POST(req: Request, { params }: Params) {
  return handleRoute(async () => {
    const ctx = await getCtx();
    const { projectId, conflictId } = await params;
    const input = await parseBody(req, adjudicateSchema);
    return ok(await adjudicateConflict(ctx, projectId, conflictId, input));
  });
}
