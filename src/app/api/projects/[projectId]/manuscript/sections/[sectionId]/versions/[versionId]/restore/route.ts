import { handleRoute, ok } from "@/server/api-utils";
import { getCtx } from "@/server/auth/session";
import { restoreVersion } from "@/server/services/manuscript";

type Params = { params: Promise<{ projectId: string; sectionId: string; versionId: string }> };

export async function POST(_req: Request, { params }: Params) {
  return handleRoute(async () => {
    const ctx = await getCtx();
    const { projectId, sectionId, versionId } = await params;
    return ok(await restoreVersion(ctx, projectId, sectionId, versionId));
  });
}
