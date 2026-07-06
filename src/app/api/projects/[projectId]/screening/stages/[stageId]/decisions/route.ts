import { handleRoute, ok, created, parseBody } from "@/server/api-utils";
import { getCtx } from "@/server/auth/session";
import {
  createDecision,
  createDecisionSchema,
  listDecisions,
  listDecisionsQuerySchema,
} from "@/server/services/screening";

type Params = { params: Promise<{ projectId: string; stageId: string }> };

// Blind-filtered decision list for one citation (?citationId=).
export async function GET(req: Request, { params }: Params) {
  return handleRoute(async () => {
    const ctx = await getCtx();
    const { projectId, stageId } = await params;
    const url = new URL(req.url);
    const { citationId } = listDecisionsQuerySchema.parse({
      citationId: url.searchParams.get("citationId") ?? undefined,
    });
    return ok(await listDecisions(ctx, projectId, stageId, citationId));
  });
}

export async function POST(req: Request, { params }: Params) {
  return handleRoute(async () => {
    const ctx = await getCtx();
    const { projectId, stageId } = await params;
    const input = await parseBody(req, createDecisionSchema);
    return created(await createDecision(ctx, projectId, stageId, input));
  });
}
