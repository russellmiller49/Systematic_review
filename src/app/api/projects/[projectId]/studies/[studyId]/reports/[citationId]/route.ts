import { handleRoute, ok } from "@/server/api-utils";
import { getCtx } from "@/server/auth/session";
import { unlinkReport } from "@/server/services/studies";

type Params = { params: Promise<{ projectId: string; studyId: string; citationId: string }> };

export async function DELETE(_req: Request, { params }: Params) {
  return handleRoute(async () => {
    const ctx = await getCtx();
    const { projectId, studyId, citationId } = await params;
    return ok(await unlinkReport(ctx, projectId, studyId, citationId));
  });
}
