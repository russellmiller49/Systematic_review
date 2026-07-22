import { handleRoute, ok } from "@/server/api-utils";
import { getCtx } from "@/server/auth/session";
import { listNotifications, listNotificationsSchema } from "@/server/services/notifications";

export async function GET(req: Request) {
  return handleRoute(async () => {
    const ctx = await getCtx();
    const url = new URL(req.url);
    const input = listNotificationsSchema.parse(Object.fromEntries(url.searchParams));
    return ok(await listNotifications(ctx, input));
  });
}
