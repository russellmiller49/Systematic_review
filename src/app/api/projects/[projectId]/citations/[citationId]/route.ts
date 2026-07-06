import { handleRoute, ok } from "@/server/api-utils";
import { getCtx } from "@/server/auth/session";
import { getCitation } from "@/server/services/citations";

// Next.js 15: params is a Promise.
type Params = { params: Promise<{ projectId: string; citationId: string }> };

export async function GET(_req: Request, { params }: Params) {
  return handleRoute(async () => {
    const ctx = await getCtx();
    const { projectId, citationId } = await params;
    return ok(await getCitation(ctx, projectId, citationId));
  });
}
