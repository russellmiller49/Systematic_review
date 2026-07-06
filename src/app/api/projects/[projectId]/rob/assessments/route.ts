// Blind-safe listing: own assessments always; all only with rob.adjudicate / project.edit.
import { handleRoute, ok } from "@/server/api-utils";
import { getCtx } from "@/server/auth/session";
import { listAssessments } from "@/server/services/rob";

type Params = { params: Promise<{ projectId: string }> };

export async function GET(req: Request, { params }: Params) {
  return handleRoute(async () => {
    const ctx = await getCtx();
    const { projectId } = await params;
    const search = new URL(req.url).searchParams;
    return ok(
      await listAssessments(ctx, projectId, {
        studyId: search.get("studyId") ?? undefined,
        toolId: search.get("toolId") ?? undefined,
      }),
    );
  });
}
