import { handleRoute, ok } from "@/server/api-utils";
import { getCtx } from "@/server/auth/session";
import { linkCohortCandidate } from "@/server/services/cohort";

// Next.js 15: params is a Promise.
type Params = { params: Promise<{ projectId: string; candidateId: string }> };

export async function POST(_req: Request, { params }: Params) {
  return handleRoute(async () => {
    const ctx = await getCtx();
    const { projectId, candidateId } = await params;
    return ok(await linkCohortCandidate(ctx, projectId, candidateId));
  });
}
