import { handleRoute, ok, parseBody } from "@/server/api-utils";
import { getCtx } from "@/server/auth/session";
import {
  deleteGuidelineScreeningPool,
  getGuidelineScreeningConfiguration,
  saveGuidelineScreeningPool,
  saveGuidelineScreeningPoolSchema,
} from "@/server/services/screening/pooled";

type Params = { params: Promise<{ projectId: string }> };

export async function GET(_req: Request, { params }: Params) {
  return handleRoute(async () => {
    const ctx = await getCtx();
    const { projectId } = await params;
    return ok(await getGuidelineScreeningConfiguration(ctx, projectId));
  });
}

export async function PUT(req: Request, { params }: Params) {
  return handleRoute(async () => {
    const ctx = await getCtx();
    const { projectId } = await params;
    const input = await parseBody(req, saveGuidelineScreeningPoolSchema);
    return ok(await saveGuidelineScreeningPool(ctx, projectId, input));
  });
}

export async function DELETE(_req: Request, { params }: Params) {
  return handleRoute(async () => {
    const ctx = await getCtx();
    const { projectId } = await params;
    return ok(await deleteGuidelineScreeningPool(ctx, projectId));
  });
}
