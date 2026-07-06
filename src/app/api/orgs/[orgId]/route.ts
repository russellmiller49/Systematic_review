import { handleRoute, ok, parseBody } from "@/server/api-utils";
import { getCtx } from "@/server/auth/session";
import { getOrg, updateOrg, updateOrgSchema } from "@/server/services/orgs";

// Next.js 15: params is a Promise.
type Params = { params: Promise<{ orgId: string }> };

export async function GET(_req: Request, { params }: Params) {
  return handleRoute(async () => {
    const ctx = await getCtx();
    const { orgId } = await params;
    return ok(await getOrg(ctx, orgId));
  });
}

export async function PATCH(req: Request, { params }: Params) {
  return handleRoute(async () => {
    const ctx = await getCtx();
    const { orgId } = await params;
    const input = await parseBody(req, updateOrgSchema);
    return ok(await updateOrg(ctx, orgId, input));
  });
}
