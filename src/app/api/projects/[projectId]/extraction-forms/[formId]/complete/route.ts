import { handleRoute, ok } from "@/server/api-utils";
import { getCtx } from "@/server/auth/session";
import { completeForm } from "@/server/services/extraction";

type Params = { params: Promise<{ projectId: string; formId: string }> };

export async function POST(_req: Request, { params }: Params) {
  return handleRoute(async () => {
    const ctx = await getCtx();
    const { projectId, formId } = await params;
    return ok(await completeForm(ctx, projectId, formId));
  });
}
