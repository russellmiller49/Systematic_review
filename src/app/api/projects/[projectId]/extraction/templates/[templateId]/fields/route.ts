import { created, handleRoute, parseBody } from "@/server/api-utils";
import { getCtx } from "@/server/auth/session";
import { createField, createFieldSchema } from "@/server/services/extraction";

type Params = { params: Promise<{ projectId: string; templateId: string }> };

export async function POST(req: Request, { params }: Params) {
  return handleRoute(async () => {
    const ctx = await getCtx();
    const { projectId, templateId } = await params;
    const input = await parseBody(req, createFieldSchema);
    return created(await createField(ctx, projectId, templateId, input));
  });
}
