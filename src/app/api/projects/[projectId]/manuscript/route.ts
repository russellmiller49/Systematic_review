import { handleRoute, ok, parseBody } from "@/server/api-utils";
import { getCtx } from "@/server/auth/session";
import {
  getManuscript,
  updateManuscript,
  updateManuscriptSchema,
} from "@/server/services/manuscript";

type Params = { params: Promise<{ projectId: string }> };

export async function GET(_req: Request, { params }: Params) {
  return handleRoute(async () => {
    const ctx = await getCtx();
    const { projectId } = await params;
    return ok(await getManuscript(ctx, projectId));
  });
}

export async function PATCH(req: Request, { params }: Params) {
  return handleRoute(async () => {
    const ctx = await getCtx();
    const { projectId } = await params;
    const input = await parseBody(req, updateManuscriptSchema);
    return ok(await updateManuscript(ctx, projectId, input));
  });
}
