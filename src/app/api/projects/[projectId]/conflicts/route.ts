import { handleRoute, ok } from "@/server/api-utils";
import { getCtx } from "@/server/auth/session";
import { listConflicts, listConflictsQuerySchema } from "@/server/services/screening";

type Params = { params: Promise<{ projectId: string }> };

export async function GET(req: Request, { params }: Params) {
  return handleRoute(async () => {
    const ctx = await getCtx();
    const { projectId } = await params;
    const url = new URL(req.url);
    const query = listConflictsQuerySchema.parse({
      stage: url.searchParams.get("stage") ?? undefined,
      status: url.searchParams.get("status") ?? undefined,
    });
    return ok(await listConflicts(ctx, projectId, query));
  });
}
