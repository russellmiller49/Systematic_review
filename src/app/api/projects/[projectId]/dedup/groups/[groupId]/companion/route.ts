import { handleRoute, ok, parseBody } from "@/server/api-utils";
import { getCtx } from "@/server/auth/session";
import {
  confirmCompanions,
  confirmCompanionGroupSchema,
} from "@/server/services/dedup";
type Params = { params: Promise<{ projectId: string; groupId: string }> };
export async function POST(req: Request, { params }: Params) {
  return handleRoute(async () => {
    const ctx = await getCtx();
    const { projectId, groupId } = await params;
    const input = await parseBody(req, confirmCompanionGroupSchema);
    return ok(await confirmCompanions(ctx, projectId, { groupId, ...input }));
  });
}
