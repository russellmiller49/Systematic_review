import { z } from "zod";
import { handleRoute, ok, parseBody } from "@/server/api-utils";
import { getCtx } from "@/server/auth/session";
import {
  listQuotas,
  saveQuotas,
  saveQuotasSchema,
} from "@/server/services/screening/quotas";

type Params = { params: Promise<{ projectId: string }> };
export async function GET(req: Request, { params }: Params) {
  return handleRoute(async () => {
    const ctx = await getCtx();
    const { projectId } = await params;
    const poolId = z
      .string()
      .min(1)
      .parse(new URL(req.url).searchParams.get("poolId"));
    return ok(await listQuotas(ctx, projectId, { poolId }));
  });
}
export async function PUT(req: Request, { params }: Params) {
  return handleRoute(async () => {
    const ctx = await getCtx();
    const { projectId } = await params;
    const poolId = z
      .string()
      .min(1)
      .parse(new URL(req.url).searchParams.get("poolId"));
    return ok(
      await saveQuotas(
        ctx,
        projectId,
        { poolId },
        await parseBody(req, saveQuotasSchema),
      ),
    );
  });
}
