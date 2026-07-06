import { handleRoute, created, parseBody } from "@/server/api-utils";
import { getCtx } from "@/server/auth/session";
import { createDomain, createDomainSchema } from "@/server/services/rob";

type Params = { params: Promise<{ projectId: string; toolId: string }> };

export async function POST(req: Request, { params }: Params) {
  return handleRoute(async () => {
    const ctx = await getCtx();
    const { projectId, toolId } = await params;
    const input = await parseBody(req, createDomainSchema);
    return created(await createDomain(ctx, projectId, toolId, input));
  });
}
