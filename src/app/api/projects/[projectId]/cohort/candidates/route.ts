import { handleRoute, ok } from "@/server/api-utils";
import { getCtx } from "@/server/auth/session";
import { listCohortCandidates, listCandidatesQuerySchema } from "@/server/services/cohort";

// Next.js 15: params is a Promise.
type Params = { params: Promise<{ projectId: string }> };

export async function GET(req: Request, { params }: Params) {
  return handleRoute(async () => {
    const ctx = await getCtx();
    const { projectId } = await params;
    const { searchParams } = new URL(req.url);
    const query = listCandidatesQuerySchema.parse({
      status: searchParams.get("status") ?? undefined,
    });
    return ok(await listCohortCandidates(ctx, projectId, query));
  });
}
