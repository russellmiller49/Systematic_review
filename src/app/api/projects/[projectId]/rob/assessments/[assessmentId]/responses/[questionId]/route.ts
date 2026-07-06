import { handleRoute, ok, parseBody } from "@/server/api-utils";
import { getCtx } from "@/server/auth/session";
import { putResponse, putResponseSchema } from "@/server/services/rob";

type Params = {
  params: Promise<{ projectId: string; assessmentId: string; questionId: string }>;
};

export async function PUT(req: Request, { params }: Params) {
  return handleRoute(async () => {
    const ctx = await getCtx();
    const { projectId, assessmentId, questionId } = await params;
    const input = await parseBody(req, putResponseSchema);
    return ok(await putResponse(ctx, projectId, assessmentId, questionId, input));
  });
}
