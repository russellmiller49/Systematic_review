import { handleRoute, ok } from "@/server/api-utils";
import { getCtx } from "@/server/auth/session";
import { listForms } from "@/server/services/extraction";

type Params = { params: Promise<{ projectId: string }> };

// Blind mirror: extractors see only their own forms; adjudicators/admins see all.
export async function GET(req: Request, { params }: Params) {
  return handleRoute(async () => {
    const ctx = await getCtx();
    const { projectId } = await params;
    const searchParams = new URL(req.url).searchParams;
    return ok(
      await listForms(ctx, projectId, {
        studyId: searchParams.get("studyId") ?? undefined,
        templateId: searchParams.get("templateId") ?? undefined,
      }),
    );
  });
}
