import { handleRoute, ok, parseBody } from "@/server/api-utils";
import { getCtx } from "@/server/auth/session";
import {
  amendmentOnlySchema,
  deletePico,
  parseOptionalBody,
  updatePico,
  updatePicoSchema,
} from "@/server/services/protocols";

type Params = { params: Promise<{ projectId: string; picoId: string }> };

export async function PATCH(req: Request, { params }: Params) {
  return handleRoute(async () => {
    const ctx = await getCtx();
    const { projectId, picoId } = await params;
    const input = await parseBody(req, updatePicoSchema);
    return ok(await updatePico(ctx, projectId, picoId, input));
  });
}

// DELETE body is optional; once screening has begun it must carry amendmentReason.
export async function DELETE(req: Request, { params }: Params) {
  return handleRoute(async () => {
    const ctx = await getCtx();
    const { projectId, picoId } = await params;
    const input = await parseOptionalBody(req, amendmentOnlySchema);
    return ok(await deletePico(ctx, projectId, picoId, input));
  });
}
