import { handleRoute, created, parseBody } from "@/server/api-utils";
import { getCtx } from "@/server/auth/session";
import { linkReport, linkReportSchema } from "@/server/services/studies";

type Params = { params: Promise<{ projectId: string; studyId: string }> };

export async function POST(req: Request, { params }: Params) {
  return handleRoute(async () => {
    const ctx = await getCtx();
    const { projectId, studyId } = await params;
    const input = await parseBody(req, linkReportSchema);
    return created(await linkReport(ctx, projectId, studyId, input));
  });
}
