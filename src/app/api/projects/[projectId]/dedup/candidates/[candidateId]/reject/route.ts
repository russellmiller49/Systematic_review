import { handleRoute, ok } from "@/server/api-utils";
import { getCtx } from "@/server/auth/session";
import { rejectCandidate } from "@/server/services/dedup";

// Next.js 15: params is a Promise.
type Params = { params: Promise<{ projectId: string; candidateId: string }> };

export async function POST(_req: Request, { params }: Params) {
  return handleRoute(async () => {
    const ctx = await getCtx();
    const { projectId, candidateId } = await params;
    return ok(await rejectCandidate(ctx, projectId, candidateId));
  });
}
