import { created, handleRoute, ok, parseBody } from "@/server/api-utils";
import { getCtx } from "@/server/auth/session";
import { startForm, startFormSchema } from "@/server/services/extraction";

type Params = { params: Promise<{ projectId: string; studyId: string }> };

// Start (or resume) an extraction form for this study; extractor is always the caller.
export async function POST(req: Request, { params }: Params) {
  return handleRoute(async () => {
    const ctx = await getCtx();
    const { projectId, studyId } = await params;
    const input = await parseBody(req, startFormSchema);
    const result = await startForm(ctx, projectId, studyId, input);
    return result.created ? created(result.form) : ok(result.form);
  });
}
