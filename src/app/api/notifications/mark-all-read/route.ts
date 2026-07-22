import { handleRoute, ok, parseBody } from "@/server/api-utils";
import { getCtx } from "@/server/auth/session";
import { markAllRead, markAllReadSchema } from "@/server/services/notifications";

export async function POST(req: Request) {
  return handleRoute(async () => {
    const ctx = await getCtx();
    const input = await parseBody(req, markAllReadSchema);
    return ok(await markAllRead(ctx, input));
  });
}
