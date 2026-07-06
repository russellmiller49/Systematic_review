import { handleRoute, ok, parseBody } from "@/server/api-utils";
import { getCtx } from "@/server/auth/session";
import {
  getTemplate,
  updateTemplate,
  updateTemplateSchema,
} from "@/server/services/extraction";

type Params = { params: Promise<{ projectId: string; templateId: string }> };

export async function GET(_req: Request, { params }: Params) {
  return handleRoute(async () => {
    const ctx = await getCtx();
    const { projectId, templateId } = await params;
    return ok(await getTemplate(ctx, projectId, templateId));
  });
}

export async function PATCH(req: Request, { params }: Params) {
  return handleRoute(async () => {
    const ctx = await getCtx();
    const { projectId, templateId } = await params;
    const input = await parseBody(req, updateTemplateSchema);
    return ok(await updateTemplate(ctx, projectId, templateId, input));
  });
}
