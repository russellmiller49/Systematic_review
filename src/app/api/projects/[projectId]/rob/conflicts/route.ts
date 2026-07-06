import { handleRoute, ok } from "@/server/api-utils";
import { getCtx } from "@/server/auth/session";
import { conflictStatusFilterSchema, listConflicts } from "@/server/services/rob";

type Params = { params: Promise<{ projectId: string }> };

export async function GET(req: Request, { params }: Params) {
  return handleRoute(async () => {
    const ctx = await getCtx();
    const { projectId } = await params;
    const status = conflictStatusFilterSchema.parse(
      new URL(req.url).searchParams.get("status") ?? undefined,
    );
    return ok(await listConflicts(ctx, projectId, { status }));
  });
}
