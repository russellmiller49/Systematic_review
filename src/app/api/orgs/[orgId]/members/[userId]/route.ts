import { handleRoute, ok, parseBody } from "@/server/api-utils";
import { getCtx } from "@/server/auth/session";
import {
  removeOrgMember,
  updateOrgMemberRole,
  updateOrgMemberSchema,
} from "@/server/services/orgs";

type Params = { params: Promise<{ orgId: string; userId: string }> };

export async function PATCH(req: Request, { params }: Params) {
  return handleRoute(async () => {
    const ctx = await getCtx();
    const { orgId, userId } = await params;
    const input = await parseBody(req, updateOrgMemberSchema);
    return ok(await updateOrgMemberRole(ctx, orgId, userId, input));
  });
}

export async function DELETE(_req: Request, { params }: Params) {
  return handleRoute(async () => {
    const ctx = await getCtx();
    const { orgId, userId } = await params;
    return ok(await removeOrgMember(ctx, orgId, userId));
  });
}
