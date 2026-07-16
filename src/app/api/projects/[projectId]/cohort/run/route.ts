import { handleRoute, ok } from "@/server/api-utils";
import { getCtx } from "@/server/auth/session";
import { runCohortDetection } from "@/server/services/cohort";

// Next.js 15: params is a Promise.
type Params = { params: Promise<{ projectId: string }> };

export async function POST(_req: Request, { params }: Params) {
  return handleRoute(async () => {
    const ctx = await getCtx();
    const { projectId } = await params;
    return ok(await runCohortDetection(ctx, projectId));
  });
}
