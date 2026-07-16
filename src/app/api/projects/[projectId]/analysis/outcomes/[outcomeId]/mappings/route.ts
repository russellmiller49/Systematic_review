import { handleRoute, ok, parseBody } from "@/server/api-utils";
import { getCtx } from "@/server/auth/session";
import { replaceMappings, replaceMappingsSchema } from "@/server/services/analysis";

type Params = { params: Promise<{ projectId: string; outcomeId: string }> };

// Replace-all semantics: the body is the complete role -> (templateId, fieldKey) map.
export async function PUT(req: Request, { params }: Params) {
  return handleRoute(async () => {
    const ctx = await getCtx();
    const { projectId, outcomeId } = await params;
    const input = await parseBody(req, replaceMappingsSchema);
    return ok(await replaceMappings(ctx, projectId, outcomeId, input));
  });
}
