import { handleRoute, ok } from "@/server/api-utils";
import { getCtx } from "@/server/auth/session";
import { computeOutcomeResults } from "@/server/services/analysis";

type Params = { params: Promise<{ projectId: string; outcomeId: string }> };

// Per-study resolved values + pooled estimates. ?provisional=1 additionally resolves
// values from IN_PROGRESS forms (rows pooled that way are flagged "provisional").
export async function GET(req: Request, { params }: Params) {
  return handleRoute(async () => {
    const ctx = await getCtx();
    const { projectId, outcomeId } = await params;
    const url = new URL(req.url);
    const includeProvisional = url.searchParams.get("provisional") === "1";
    return ok(await computeOutcomeResults(ctx, projectId, outcomeId, { includeProvisional }));
  });
}
