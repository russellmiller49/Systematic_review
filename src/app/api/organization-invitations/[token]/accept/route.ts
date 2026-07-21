import { handleRoute, ok } from "@/server/api-utils";
import { getCtx } from "@/server/auth/session";
import { acceptOrganizationInvitation } from "@/server/services/orgs";

type Params = { params: Promise<{ token: string }> };

export async function POST(_req: Request, { params }: Params) {
  return handleRoute(async () => {
    const ctx = await getCtx();
    const { token } = await params;
    return ok(await acceptOrganizationInvitation(ctx, token));
  });
}
