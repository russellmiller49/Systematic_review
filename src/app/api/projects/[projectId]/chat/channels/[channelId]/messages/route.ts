import { created, handleRoute, ok, parseBody } from "@/server/api-utils";
import { getCtx } from "@/server/auth/session";
import {
  listMessages,
  listMessagesSchema,
  postMessage,
  postMessageSchema,
} from "@/server/services/chat";

type Params = { params: Promise<{ projectId: string; channelId: string }> };

export async function GET(req: Request, { params }: Params) {
  return handleRoute(async () => {
    const ctx = await getCtx();
    const { projectId, channelId } = await params;
    const url = new URL(req.url);
    const query = listMessagesSchema.parse(Object.fromEntries(url.searchParams));
    return ok(await listMessages(ctx, projectId, channelId, query));
  });
}

export async function POST(req: Request, { params }: Params) {
  return handleRoute(async () => {
    const ctx = await getCtx();
    const { projectId, channelId } = await params;
    const input = await parseBody(req, postMessageSchema);
    return created(await postMessage(ctx, projectId, channelId, input));
  });
}
