import { handleRoute, ok, parseBody } from "@/server/api-utils";
import { getCtx } from "@/server/auth/session";
import { bibliographySchema, formatBibliography } from "@/server/services/references";

type Params = { params: Promise<{ projectId: string }> };

// POST because referenceIds (first-use order) can be hundreds of ids — compute-POST
// precedent: dedup/run, cohort/run.
export async function POST(req: Request, { params }: Params) {
  return handleRoute(async () => {
    const ctx = await getCtx();
    const { projectId } = await params;
    const input = await parseBody(req, bibliographySchema);
    return ok(await formatBibliography(ctx, projectId, input));
  });
}
