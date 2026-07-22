import { handleRoute, ok, parseBody } from "@/server/api-utils";
import { getCtx } from "@/server/auth/session";
import { lookupReference, lookupReferenceSchema } from "@/server/services/references";

type Params = { params: Promise<{ projectId: string }> };

export async function POST(req: Request, { params }: Params) {
  return handleRoute(async () => {
    const ctx = await getCtx();
    const { projectId } = await params;
    const input = await parseBody(req, lookupReferenceSchema);
    return ok(await lookupReference(ctx, projectId, input));
  });
}
