import { handleRoute, ok, parseBody } from "@/server/api-utils";
import { getCtx } from "@/server/auth/session";
import {
  deleteReference,
  updateReference,
  updateReferenceSchema,
} from "@/server/services/references";

type Params = { params: Promise<{ projectId: string; referenceId: string }> };

export async function PATCH(req: Request, { params }: Params) {
  return handleRoute(async () => {
    const ctx = await getCtx();
    const { projectId, referenceId } = await params;
    const input = await parseBody(req, updateReferenceSchema);
    return ok(await updateReference(ctx, projectId, referenceId, input));
  });
}

export async function DELETE(_req: Request, { params }: Params) {
  return handleRoute(async () => {
    const ctx = await getCtx();
    const { projectId, referenceId } = await params;
    return ok(await deleteReference(ctx, projectId, referenceId));
  });
}
