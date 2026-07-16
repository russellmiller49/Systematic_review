import { handleRoute, ok } from "@/server/api-utils";
import { getCtx } from "@/server/auth/session";
import { getExtractionMatrix, matrixQuerySchema } from "@/server/services/extraction/matrix";

type Params = { params: Promise<{ projectId: string }> };

// Cross-study extraction matrix for one template — ?templateId=. Blinding mirrors
// listForms: non-adjudicator/admin callers get only their own forms' entries.
export async function GET(req: Request, { params }: Params) {
  return handleRoute(async () => {
    const ctx = await getCtx();
    const { projectId } = await params;
    const url = new URL(req.url);
    const query = matrixQuerySchema.parse({
      templateId: url.searchParams.get("templateId") ?? undefined,
    });
    return ok(await getExtractionMatrix(ctx, projectId, query));
  });
}
