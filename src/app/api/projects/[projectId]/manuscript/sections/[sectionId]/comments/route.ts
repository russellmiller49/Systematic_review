import { created, handleRoute, ok, parseBody } from "@/server/api-utils";
import { getCtx } from "@/server/auth/session";
import { createComment, createCommentSchema, listComments } from "@/server/services/manuscript";

type Params = { params: Promise<{ projectId: string; sectionId: string }> };

export async function GET(req: Request, { params }: Params) {
  return handleRoute(async () => {
    const ctx = await getCtx();
    const { projectId, sectionId } = await params;
    const url = new URL(req.url);
    const status = url.searchParams.get("status");
    return ok(
      await listComments(ctx, projectId, sectionId, {
        status: status === "OPEN" || status === "RESOLVED" ? status : undefined,
      }),
    );
  });
}

export async function POST(req: Request, { params }: Params) {
  return handleRoute(async () => {
    const ctx = await getCtx();
    const { projectId, sectionId } = await params;
    const input = await parseBody(req, createCommentSchema);
    return created(await createComment(ctx, projectId, sectionId, input));
  });
}
