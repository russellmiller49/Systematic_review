import { handleRoute, ok, parseBody } from "@/server/api-utils";
import { getCtx } from "@/server/auth/session";
import { openDirectChannel, openDirectChannelSchema } from "@/server/services/chat";

type Params = { params: Promise<{ projectId: string }> };

export async function POST(req: Request, { params }: Params) {
  return handleRoute(async () => {
    const ctx = await getCtx();
    const { projectId } = await params;
    const input = await parseBody(req, openDirectChannelSchema);
    return ok(await openDirectChannel(ctx, projectId, input));
  });
}
