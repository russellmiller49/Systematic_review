import { handleRoute, ok } from "@/server/api-utils";
import { getCtx } from "@/server/auth/session";
import { getMe } from "@/server/services/users";

export async function GET() {
  return handleRoute(async () => {
    const ctx = await getCtx();
    return ok(await getMe(ctx.userId));
  });
}
