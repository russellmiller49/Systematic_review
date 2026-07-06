// Start (or resume) the caller's assessment of a study with a tool.
import { handleRoute, created, parseBody } from "@/server/api-utils";
import { getCtx } from "@/server/auth/session";
import { startAssessment, startAssessmentSchema } from "@/server/services/rob";

type Params = { params: Promise<{ projectId: string; studyId: string }> };

export async function POST(req: Request, { params }: Params) {
  return handleRoute(async () => {
    const ctx = await getCtx();
    const { projectId, studyId } = await params;
    const input = await parseBody(req, startAssessmentSchema);
    return created(await startAssessment(ctx, projectId, studyId, input));
  });
}
