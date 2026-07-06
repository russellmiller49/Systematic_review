import { handleRoute, ok, parseBody } from "@/server/api-utils";
import { getCtx } from "@/server/auth/session";
import { deleteField, updateField, updateFieldSchema } from "@/server/services/extraction";

type Params = { params: Promise<{ projectId: string; templateId: string; fieldId: string }> };

export async function PATCH(req: Request, { params }: Params) {
  return handleRoute(async () => {
    const ctx = await getCtx();
    const { projectId, templateId, fieldId } = await params;
    const input = await parseBody(req, updateFieldSchema);
    return ok(await updateField(ctx, projectId, templateId, fieldId, input));
  });
}

export async function DELETE(_req: Request, { params }: Params) {
  return handleRoute(async () => {
    const ctx = await getCtx();
    const { projectId, templateId, fieldId } = await params;
    return ok(await deleteField(ctx, projectId, templateId, fieldId));
  });
}
