// Complete → same-transaction conflict detection (R15).
import { handleRoute, ok } from "@/server/api-utils";
import { getCtx } from "@/server/auth/session";
import { completeAssessment } from "@/server/services/rob";

type Params = { params: Promise<{ projectId: string; assessmentId: string }> };

export async function POST(_req: Request, { params }: Params) {
  return handleRoute(async () => {
    const ctx = await getCtx();
    const { projectId, assessmentId } = await params;
    return ok(await completeAssessment(ctx, projectId, assessmentId));
  });
}
