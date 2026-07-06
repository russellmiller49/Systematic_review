import { handleRoute, ok } from "@/server/api-utils";
import { getCtx } from "@/server/auth/session";
import { listCitations, listCitationsQuerySchema } from "@/server/services/citations";

// Next.js 15: params is a Promise.
type Params = { params: Promise<{ projectId: string }> };

// ?status=ACTIVE|DUPLICATE (default ACTIVE), ?q= (title contains), ?batchId=,
// cursor pagination (?cursor=<id>&limit=, default 50, max 200).
export async function GET(req: Request, { params }: Params) {
  return handleRoute(async () => {
    const ctx = await getCtx();
    const { projectId } = await params;
    const raw = Object.fromEntries(new URL(req.url).searchParams);
    const query = listCitationsQuerySchema.parse(raw);
    return ok(await listCitations(ctx, projectId, query));
  });
}
