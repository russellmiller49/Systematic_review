import { handleRoute, ok } from "@/server/api-utils";
import { getCtx } from "@/server/auth/session";
import { unreadCount } from "@/server/services/notifications";

export async function GET() {
  return handleRoute(async () => {
    const ctx = await getCtx();
    return ok(await unreadCount(ctx));
  });
}
