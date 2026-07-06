import { handleRoute, ok, created, parseBody } from "@/server/api-utils";
import { getCtx } from "@/server/auth/session";
import { addOrgMember, addOrgMemberSchema, listOrgMembers } from "@/server/services/orgs";

type Params = { params: Promise<{ orgId: string }> };

export async function GET(_req: Request, { params }: Params) {
  return handleRoute(async () => {
    const ctx = await getCtx();
    const { orgId } = await params;
    return ok(await listOrgMembers(ctx, orgId));
  });
}

export async function POST(req: Request, { params }: Params) {
  return handleRoute(async () => {
    const ctx = await getCtx();
    const { orgId } = await params;
    const input = await parseBody(req, addOrgMemberSchema);
    return created(await addOrgMember(ctx, orgId, input));
  });
}
