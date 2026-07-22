import { handleRoute, ok } from "@/server/api-utils";
import { getCtx } from "@/server/auth/session";
import { listAssignments, listAssignmentsSchema } from "@/server/services/chat";

type Params = { params: Promise<{ projectId: string }> };

export async function GET(req: Request, { params }: Params) {
  return handleRoute(async () => {
    const ctx = await getCtx();
    const { projectId } = await params;
    const url = new URL(req.url);
    const input = listAssignmentsSchema.parse(Object.fromEntries(url.searchParams));
    return ok(await listAssignments(ctx, projectId, input));
  });
}
