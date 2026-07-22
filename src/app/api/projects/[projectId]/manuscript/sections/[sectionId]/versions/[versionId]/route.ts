import { handleRoute, ok } from "@/server/api-utils";
import { getCtx } from "@/server/auth/session";
import { getVersion } from "@/server/services/manuscript";

type Params = { params: Promise<{ projectId: string; sectionId: string; versionId: string }> };

export async function GET(_req: Request, { params }: Params) {
  return handleRoute(async () => {
    const ctx = await getCtx();
    const { projectId, sectionId, versionId } = await params;
    return ok(await getVersion(ctx, projectId, sectionId, versionId));
  });
}
