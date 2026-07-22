import { handleRoute, ok, parseBody } from "@/server/api-utils";
import { getCtx } from "@/server/auth/session";
import { markRead, markReadSchema } from "@/server/services/chat";

type Params = { params: Promise<{ projectId: string; channelId: string }> };

export async function POST(req: Request, { params }: Params) {
  return handleRoute(async () => {
    const ctx = await getCtx();
    const { projectId, channelId } = await params;
    const input = await parseBody(req, markReadSchema);
    return ok(await markRead(ctx, projectId, channelId, input));
  });
}
