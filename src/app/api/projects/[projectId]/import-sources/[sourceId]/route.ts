import { handleRoute, ok, parseBody } from "@/server/api-utils";
import { getCtx } from "@/server/auth/session";
import {
  deleteImportSource,
  updateImportSource,
  updateImportSourceSchema,
} from "@/server/services/imports";

// Next.js 15: params is a Promise.
type Params = { params: Promise<{ projectId: string; sourceId: string }> };

export async function PATCH(req: Request, { params }: Params) {
  return handleRoute(async () => {
    const ctx = await getCtx();
    const { projectId, sourceId } = await params;
    const input = await parseBody(req, updateImportSourceSchema);
    return ok(await updateImportSource(ctx, projectId, sourceId, input));
  });
}

export async function DELETE(_req: Request, { params }: Params) {
  return handleRoute(async () => {
    const ctx = await getCtx();
    const { projectId, sourceId } = await params;
    return ok(await deleteImportSource(ctx, projectId, sourceId));
  });
}
