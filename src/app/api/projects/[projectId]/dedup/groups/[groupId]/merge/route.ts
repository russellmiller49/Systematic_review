import { handleRoute, ok, parseBody } from "@/server/api-utils";
import { getCtx } from "@/server/auth/session";
import { mergeGroup, mergeGroupSchema } from "@/server/services/dedup";

// Next.js 15: params is a Promise.
type Params = { params: Promise<{ projectId: string; groupId: string }> };

export async function POST(req: Request, { params }: Params) {
  return handleRoute(async () => {
    const ctx = await getCtx();
    const { projectId, groupId } = await params;
    const input = await parseBody(req, mergeGroupSchema);
    return ok(await mergeGroup(ctx, projectId, groupId, input));
  });
}
