import { handleRoute, ok, parseBody } from "@/server/api-utils";
import { getCtx } from "@/server/auth/session";
import {
  deleteScreeningKeyword,
  updateScreeningKeyword,
  updateScreeningKeywordSchema,
} from "@/server/services/screening-keywords";

type Params = { params: Promise<{ projectId: string; keywordId: string }> };

export async function PATCH(req: Request, { params }: Params) {
  return handleRoute(async () => {
    const ctx = await getCtx();
    const { projectId, keywordId } = await params;
    const input = await parseBody(req, updateScreeningKeywordSchema);
    return ok(await updateScreeningKeyword(ctx, projectId, keywordId, input));
  });
}

export async function DELETE(_req: Request, { params }: Params) {
  return handleRoute(async () => {
    const ctx = await getCtx();
    const { projectId, keywordId } = await params;
    return ok(await deleteScreeningKeyword(ctx, projectId, keywordId));
  });
}
