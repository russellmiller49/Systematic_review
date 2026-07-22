import { handleRoute, ok, parseBody } from "@/server/api-utils";
import { getCtx } from "@/server/auth/session";
import { deleteMessage, editMessage, editMessageSchema } from "@/server/services/chat";

type Params = { params: Promise<{ projectId: string; messageId: string }> };

export async function PATCH(req: Request, { params }: Params) {
  return handleRoute(async () => {
    const ctx = await getCtx();
    const { projectId, messageId } = await params;
    const input = await parseBody(req, editMessageSchema);
    return ok(await editMessage(ctx, projectId, messageId, input));
  });
}

export async function DELETE(_req: Request, { params }: Params) {
  return handleRoute(async () => {
    const ctx = await getCtx();
    const { projectId, messageId } = await params;
    return ok(await deleteMessage(ctx, projectId, messageId));
  });
}
