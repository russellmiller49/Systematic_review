import { handleRoute, ok, parseBody } from "@/server/api-utils";
import { getCtx } from "@/server/auth/session";
import {
  amendmentOnlySchema,
  deleteOutcome,
  parseOptionalBody,
  updateOutcome,
  updateOutcomeSchema,
} from "@/server/services/protocols";

type Params = { params: Promise<{ projectId: string; outcomeId: string }> };

export async function PATCH(req: Request, { params }: Params) {
  return handleRoute(async () => {
    const ctx = await getCtx();
    const { projectId, outcomeId } = await params;
    const input = await parseBody(req, updateOutcomeSchema);
    return ok(await updateOutcome(ctx, projectId, outcomeId, input));
  });
}

// DELETE body is optional; once screening has begun it must carry amendmentReason.
export async function DELETE(req: Request, { params }: Params) {
  return handleRoute(async () => {
    const ctx = await getCtx();
    const { projectId, outcomeId } = await params;
    const input = await parseOptionalBody(req, amendmentOnlySchema);
    return ok(await deleteOutcome(ctx, projectId, outcomeId, input));
  });
}
