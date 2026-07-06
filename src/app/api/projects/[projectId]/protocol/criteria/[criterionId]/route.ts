import { handleRoute, ok, parseBody } from "@/server/api-utils";
import { getCtx } from "@/server/auth/session";
import {
  amendmentOnlySchema,
  deleteCriterion,
  parseOptionalBody,
  updateCriterion,
  updateCriterionSchema,
} from "@/server/services/protocols";

type Params = { params: Promise<{ projectId: string; criterionId: string }> };

export async function PATCH(req: Request, { params }: Params) {
  return handleRoute(async () => {
    const ctx = await getCtx();
    const { projectId, criterionId } = await params;
    const input = await parseBody(req, updateCriterionSchema);
    return ok(await updateCriterion(ctx, projectId, criterionId, input));
  });
}

// DELETE body is optional; once screening has begun it must carry amendmentReason.
export async function DELETE(req: Request, { params }: Params) {
  return handleRoute(async () => {
    const ctx = await getCtx();
    const { projectId, criterionId } = await params;
    const input = await parseOptionalBody(req, amendmentOnlySchema);
    return ok(await deleteCriterion(ctx, projectId, criterionId, input));
  });
}
