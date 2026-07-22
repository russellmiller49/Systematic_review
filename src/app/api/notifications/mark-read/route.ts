import { handleRoute, ok, parseBody } from "@/server/api-utils";
import { getCtx } from "@/server/auth/session";
import { markRead, markReadSchema } from "@/server/services/notifications";

export async function POST(req: Request) {
  return handleRoute(async () => {
    const ctx = await getCtx();
    const input = await parseBody(req, markReadSchema);
    return ok(await markRead(ctx, input));
  });
}
