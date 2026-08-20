import { handleRoute, ok, parseBody } from "@/server/api-utils";
import { getCtx } from "@/server/auth/session";
import {
  addCitationAbstract,
  addCitationAbstractSchema,
  getCitation,
} from "@/server/services/citations";

// Next.js 15: params is a Promise.
type Params = { params: Promise<{ projectId: string; citationId: string }> };

export async function GET(_req: Request, { params }: Params) {
  return handleRoute(async () => {
    const ctx = await getCtx();
    const { projectId, citationId } = await params;
    return ok(await getCitation(ctx, projectId, citationId));
  });
}

export async function PATCH(req: Request, { params }: Params) {
  return handleRoute(async () => {
    const ctx = await getCtx();
    const { projectId, citationId } = await params;
    const input = await parseBody(req, addCitationAbstractSchema);
    return ok(await addCitationAbstract(ctx, projectId, citationId, input));
  });
}
