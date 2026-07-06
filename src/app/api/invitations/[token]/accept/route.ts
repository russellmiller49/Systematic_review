import { handleRoute, ok } from "@/server/api-utils";
import { getCtx } from "@/server/auth/session";
import { acceptInvitation } from "@/server/services/projects";

// Next.js 15: params is a Promise.
type Params = { params: Promise<{ token: string }> };

export async function POST(_req: Request, { params }: Params) {
  return handleRoute(async () => {
    const ctx = await getCtx();
    const { token } = await params;
    return ok(await acceptInvitation(ctx, token));
  });
}
