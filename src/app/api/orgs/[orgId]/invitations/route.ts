import { created, handleRoute, ok, parseBody } from "@/server/api-utils";
import { getCtx } from "@/server/auth/session";
import {
  createOrganizationInvitation,
  createOrganizationInvitationSchema,
  listOrganizationInvitations,
} from "@/server/services/orgs";

type Params = { params: Promise<{ orgId: string }> };

export async function GET(_req: Request, { params }: Params) {
  return handleRoute(async () => {
    const ctx = await getCtx();
    const { orgId } = await params;
    return ok(await listOrganizationInvitations(ctx, orgId));
  });
}

export async function POST(req: Request, { params }: Params) {
  return handleRoute(async () => {
    const ctx = await getCtx();
    const { orgId } = await params;
    const input = await parseBody(req, createOrganizationInvitationSchema);
    return created(await createOrganizationInvitation(ctx, orgId, input));
  });
}
