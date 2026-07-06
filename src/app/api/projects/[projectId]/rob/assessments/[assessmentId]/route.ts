import { handleRoute, ok, parseBody } from "@/server/api-utils";
import { getCtx } from "@/server/auth/session";
import { updateAssessment, updateAssessmentSchema } from "@/server/services/rob";

type Params = { params: Promise<{ projectId: string; assessmentId: string }> };

export async function PATCH(req: Request, { params }: Params) {
  return handleRoute(async () => {
    const ctx = await getCtx();
    const { projectId, assessmentId } = await params;
    const input = await parseBody(req, updateAssessmentSchema);
    return ok(await updateAssessment(ctx, projectId, assessmentId, input));
  });
}
