import { handleRoute, ok } from "@/server/api-utils";
import { getCtx } from "@/server/auth/session";
import { listConflicts, listConflictsQuerySchema } from "@/server/services/extraction";

type Params = { params: Promise<{ projectId: string }> };

export async function GET(req: Request, { params }: Params) {
  return handleRoute(async () => {
    const ctx = await getCtx();
    const { projectId } = await params;
    const searchParams = new URL(req.url).searchParams;
    const query = listConflictsQuerySchema.parse({
      status: searchParams.get("status") ?? undefined,
    });
    return ok(await listConflicts(ctx, projectId, query));
  });
}
