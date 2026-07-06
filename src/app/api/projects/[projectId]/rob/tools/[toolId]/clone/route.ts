// R9: built-in / in-use tools are consumed by cloning into the project as a DRAFT copy.
import { handleRoute, created } from "@/server/api-utils";
import { getCtx } from "@/server/auth/session";
import { cloneTool } from "@/server/services/rob";

type Params = { params: Promise<{ projectId: string; toolId: string }> };

export async function POST(_req: Request, { params }: Params) {
  return handleRoute(async () => {
    const ctx = await getCtx();
    const { projectId, toolId } = await params;
    return created(await cloneTool(ctx, projectId, toolId));
  });
}
