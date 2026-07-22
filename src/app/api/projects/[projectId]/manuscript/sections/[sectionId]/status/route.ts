import { handleRoute, ok, parseBody } from "@/server/api-utils";
import { getCtx } from "@/server/auth/session";
import { sectionStatusSchema, setSectionStatus } from "@/server/services/manuscript";

type Params = { params: Promise<{ projectId: string; sectionId: string }> };

export async function PUT(req: Request, { params }: Params) {
  return handleRoute(async () => {
    const ctx = await getCtx();
    const { projectId, sectionId } = await params;
    const input = await parseBody(req, sectionStatusSchema);
    return ok(await setSectionStatus(ctx, projectId, sectionId, input));
  });
}
