import { handleRoute, ok } from "@/server/api-utils";
import { getCtx } from "@/server/auth/session";
import { computeSof } from "@/server/services/grade";

type Params = { params: Promise<{ projectId: string }> };

// Summary of findings across every outcome (computed live from final-only shared inputs).
export async function GET(_req: Request, { params }: Params) {
  return handleRoute(async () => {
    const ctx = await getCtx();
    const { projectId } = await params;
    return ok(await computeSof(ctx, projectId));
  });
}
