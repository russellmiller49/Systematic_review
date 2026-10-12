import { handleRoute, ok } from "@/server/api-utils";
import { getCtx } from "@/server/auth/session";
import { getScreeningScope } from "@/server/services/screening/scope";
import { z } from "zod";

export async function GET(req: Request, { params }: { params: Promise<{ projectId: string }> }) {
  return handleRoute(async () => {
    const ctx = await getCtx();
    const { projectId } = await params;
    const poolId = z
      .string()
      .trim()
      .min(1)
      .optional()
      .parse(new URL(req.url).searchParams.get("poolId") ?? undefined);
    return ok(await getScreeningScope(ctx, projectId, poolId));
  });
}
