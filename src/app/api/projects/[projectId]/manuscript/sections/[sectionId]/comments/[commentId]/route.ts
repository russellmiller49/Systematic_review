import { handleRoute, ok, parseBody } from "@/server/api-utils";
import { getCtx } from "@/server/auth/session";
import {
  commentStatusSchema,
  deleteComment,
  setCommentStatus,
} from "@/server/services/manuscript";

type Params = { params: Promise<{ projectId: string; sectionId: string; commentId: string }> };

export async function PATCH(req: Request, { params }: Params) {
  return handleRoute(async () => {
    const ctx = await getCtx();
    const { projectId, sectionId, commentId } = await params;
    const input = await parseBody(req, commentStatusSchema);
    return ok(await setCommentStatus(ctx, projectId, sectionId, commentId, input));
  });
}

export async function DELETE(_req: Request, { params }: Params) {
  return handleRoute(async () => {
    const ctx = await getCtx();
    const { projectId, sectionId, commentId } = await params;
    return ok(await deleteComment(ctx, projectId, sectionId, commentId));
  });
}
