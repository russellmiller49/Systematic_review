import { handleRoute, ok, parseBody } from "@/server/api-utils";
import { getCtx } from "@/server/auth/session";
import { reopenPooledConflict, reopenPooledConflictSchema } from "@/server/services/screening/pooled-adjudication";
type Params = { params: Promise<{ projectId: string }> };
export async function POST(req: Request, { params }: Params) {
  return handleRoute(async () => {
    const ctx = await getCtx();
    const { projectId } = await params;
    return ok(await reopenPooledConflict(ctx, projectId, await parseBody(req, reopenPooledConflictSchema)));
  });
}
