import { handleRoute, ok } from "@/server/api-utils";
import { getCtx } from "@/server/auth/session";
import { getFullTextQueue, queueFilterSchema } from "@/server/services/fulltext";

// Next.js 15: params is a Promise.
type Params = { params: Promise<{ projectId: string }> };

// GET ?retrieval=pending|retrieved|not_retrieved → full-text screening queue.
export async function GET(req: Request, { params }: Params) {
  return handleRoute(async () => {
    const ctx = await getCtx();
    const { projectId } = await params;
    const url = new URL(req.url);
    const filter = queueFilterSchema.parse({
      retrieval: url.searchParams.get("retrieval") ?? undefined,
    });
    return ok(await getFullTextQueue(ctx, projectId, filter));
  });
}
