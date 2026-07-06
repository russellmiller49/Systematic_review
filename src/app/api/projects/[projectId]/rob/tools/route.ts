import { handleRoute, ok, created, parseBody } from "@/server/api-utils";
import { getCtx } from "@/server/auth/session";
import { createTool, createToolSchema, listProjectTools } from "@/server/services/rob";

type Params = { params: Promise<{ projectId: string }> };

export async function GET(_req: Request, { params }: Params) {
  return handleRoute(async () => {
    const ctx = await getCtx();
    const { projectId } = await params;
    return ok(await listProjectTools(ctx, projectId));
  });
}

export async function POST(req: Request, { params }: Params) {
  return handleRoute(async () => {
    const ctx = await getCtx();
    const { projectId } = await params;
    const input = await parseBody(req, createToolSchema);
    return created(await createTool(ctx, projectId, input));
  });
}
