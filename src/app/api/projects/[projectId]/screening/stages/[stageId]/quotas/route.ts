import { handleRoute, ok, parseBody } from "@/server/api-utils";
import { getCtx } from "@/server/auth/session";
import {
  listQuotas,
  saveQuotas,
  saveQuotasSchema,
} from "@/server/services/screening/quotas";

type Params = { params: Promise<{ projectId: string; stageId: string }> };
export async function GET(req: Request, { params }: Params) {
  return handleRoute(async () => {
    const ctx = await getCtx();
    const { projectId, stageId } = await params;

    return ok(await listQuotas(ctx, projectId, { stageId }));
  });
}
export async function PUT(req: Request, { params }: Params) {
  return handleRoute(async () => {
    const ctx = await getCtx();
    const { projectId, stageId } = await params;

    return ok(
      await saveQuotas(
        ctx,
        projectId,
        { stageId },
        await parseBody(req, saveQuotasSchema),
      ),
    );
  });
}
