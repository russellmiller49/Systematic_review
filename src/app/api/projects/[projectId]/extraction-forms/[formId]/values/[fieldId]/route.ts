import { handleRoute, ok, parseBody } from "@/server/api-utils";
import { getCtx } from "@/server/auth/session";
import { upsertValue, upsertValueSchema } from "@/server/services/extraction";

type Params = { params: Promise<{ projectId: string; formId: string; fieldId: string }> };

// Upsert a typed value (value: null clears it).
export async function PUT(req: Request, { params }: Params) {
  return handleRoute(async () => {
    const ctx = await getCtx();
    const { projectId, formId, fieldId } = await params;
    const input = await parseBody(req, upsertValueSchema);
    return ok(await upsertValue(ctx, projectId, formId, fieldId, input));
  });
}
