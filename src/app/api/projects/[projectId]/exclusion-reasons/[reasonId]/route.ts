import { handleRoute, ok, parseBody } from "@/server/api-utils";
import { getCtx } from "@/server/auth/session";
import {
  deleteExclusionReason,
  updateExclusionReason,
  updateExclusionReasonSchema,
} from "@/server/services/protocols";

type Params = { params: Promise<{ projectId: string; reasonId: string }> };

export async function PATCH(req: Request, { params }: Params) {
  return handleRoute(async () => {
    const ctx = await getCtx();
    const { projectId, reasonId } = await params;
    const input = await parseBody(req, updateExclusionReasonSchema);
    return ok(await updateExclusionReason(ctx, projectId, reasonId, input));
  });
}

// Hard-deletes when unreferenced; deactivates when cited by decisions/adjudications.
export async function DELETE(_req: Request, { params }: Params) {
  return handleRoute(async () => {
    const ctx = await getCtx();
    const { projectId, reasonId } = await params;
    return ok(await deleteExclusionReason(ctx, projectId, reasonId));
  });
}
