import { handleRoute, ok, parseBody } from "@/server/api-utils";
import { getCtx } from "@/server/auth/session";
import { setExclusionSchema, setStudyExclusion } from "@/server/services/analysis";

type Params = {
  params: Promise<{ projectId: string; outcomeId: string; studyId: string }>;
};

// Manual per-outcome study exclusion (sensitivity valve). Idempotent set/unset;
// a reason is required when excluding.
export async function PUT(req: Request, { params }: Params) {
  return handleRoute(async () => {
    const ctx = await getCtx();
    const { projectId, outcomeId, studyId } = await params;
    const input = await parseBody(req, setExclusionSchema);
    return ok(await setStudyExclusion(ctx, projectId, outcomeId, studyId, input));
  });
}
