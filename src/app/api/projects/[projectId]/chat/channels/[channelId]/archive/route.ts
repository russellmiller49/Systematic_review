import { handleRoute, ok } from "@/server/api-utils";
import { getCtx } from "@/server/auth/session";
import { archiveTopicChannel } from "@/server/services/chat";

type Params = { params: Promise<{ projectId: string; channelId: string }> };

export async function POST(_req: Request, { params }: Params) {
  return handleRoute(async () => {
    const ctx = await getCtx();
    const { projectId, channelId } = await params;
    return ok(await archiveTopicChannel(ctx, projectId, channelId));
  });
}
