import { handleRoute, ok, parseBody } from "@/server/api-utils";
import { getCtx } from "@/server/auth/session";
import {
  deleteOutcome,
  getOutcome,
  updateOutcome,
  updateOutcomeSchema,
} from "@/server/services/analysis";

type Params = { params: Promise<{ projectId: string; outcomeId: string }> };

export async function GET(_req: Request, { params }: Params) {
  return handleRoute(async () => {
    const ctx = await getCtx();
    const { projectId, outcomeId } = await params;
    return ok(await getOutcome(ctx, projectId, outcomeId));
  });
}

// Measure is immutable — the update schema deliberately has no measure field.
export async function PATCH(req: Request, { params }: Params) {
  return handleRoute(async () => {
    const ctx = await getCtx();
    const { projectId, outcomeId } = await params;
    const input = await parseBody(req, updateOutcomeSchema);
    return ok(await updateOutcome(ctx, projectId, outcomeId, input));
  });
}

export async function DELETE(_req: Request, { params }: Params) {
  return handleRoute(async () => {
    const ctx = await getCtx();
    const { projectId, outcomeId } = await params;
    return ok(await deleteOutcome(ctx, projectId, outcomeId));
  });
}
