import { handleRoute, ok, parseBody } from "@/server/api-utils";
import { getCtx } from "@/server/auth/session";
import { reopenCitation, reopenSchema } from "@/server/services/screening";

type Params = { params: Promise<{ projectId: string; citationId: string }> };

// R5: admin/adjudicator reopen — deletes the stage result (audited with previous value),
// voids a resolved conflict, and makes decisions editable again.
export async function POST(req: Request, { params }: Params) {
  return handleRoute(async () => {
    const ctx = await getCtx();
    const { projectId, citationId } = await params;
    const input = await parseBody(req, reopenSchema);
    return ok(await reopenCitation(ctx, projectId, citationId, input));
  });
}
