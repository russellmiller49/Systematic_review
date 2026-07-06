import { created, handleRoute } from "@/server/api-utils";
import { getCtx } from "@/server/auth/session";
import { createNewVersion } from "@/server/services/extraction";

type Params = { params: Promise<{ projectId: string; templateId: string }> };

export async function POST(_req: Request, { params }: Params) {
  return handleRoute(async () => {
    const ctx = await getCtx();
    const { projectId, templateId } = await params;
    return created(await createNewVersion(ctx, projectId, templateId));
  });
}
