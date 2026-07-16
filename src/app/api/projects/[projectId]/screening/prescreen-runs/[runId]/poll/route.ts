import { handleRoute, ok } from "@/server/api-utils";
import { getCtx } from "@/server/auth/session";
import { pollPrescreenRun } from "@/server/services/ai-screening";

type Params = { params: Promise<{ projectId: string; runId: string }> };

// Fetches provider batch status and, on a terminal state, ingests the results.
// Idempotent — safe to call repeatedly and concurrently.
export async function POST(_req: Request, { params }: Params) {
  return handleRoute(async () => {
    const ctx = await getCtx();
    const { projectId, runId } = await params;
    return ok(await pollPrescreenRun(ctx, projectId, runId));
  });
}
