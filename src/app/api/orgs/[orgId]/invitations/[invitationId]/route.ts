import { handleRoute, ok } from "@/server/api-utils";
import { getCtx } from "@/server/auth/session";
import { revokeOrganizationInvitation } from "@/server/services/orgs";

type Params = { params: Promise<{ orgId: string; invitationId: string }> };

export async function DELETE(_req: Request, { params }: Params) {
  return handleRoute(async () => {
    const ctx = await getCtx();
    const { orgId, invitationId } = await params;
    return ok(await revokeOrganizationInvitation(ctx, orgId, invitationId));
  });
}
