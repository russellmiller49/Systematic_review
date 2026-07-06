import { handleRoute, ok, parseBody } from "@/server/api-utils";
import { getCtx } from "@/server/auth/session";
import { deleteDomain, updateDomain, updateDomainSchema } from "@/server/services/rob";

type Params = { params: Promise<{ projectId: string; toolId: string; domainId: string }> };

export async function PATCH(req: Request, { params }: Params) {
  return handleRoute(async () => {
    const ctx = await getCtx();
    const { projectId, toolId, domainId } = await params;
    const input = await parseBody(req, updateDomainSchema);
    return ok(await updateDomain(ctx, projectId, toolId, domainId, input));
  });
}

export async function DELETE(_req: Request, { params }: Params) {
  return handleRoute(async () => {
    const ctx = await getCtx();
    const { projectId, toolId, domainId } = await params;
    return ok(await deleteDomain(ctx, projectId, toolId, domainId));
  });
}
