import { handleRoute, ok, parseBody } from "@/server/api-utils";
import { getCtx } from "@/server/auth/session";
import { applySuggestion, applySuggestionSchema } from "@/server/services/rob";

type Params = { params: Promise<{ projectId: string; assessmentId: string }> };

// Apply the AI suggestion for one domain into the caller's own assessment (judgment +
// valid signaling answers, atomically). Server-authoritative — the body carries only
// the domainId; everything else is copied from the RobSuggestion row.
export async function POST(req: Request, { params }: Params) {
  return handleRoute(async () => {
    const ctx = await getCtx();
    const { projectId, assessmentId } = await params;
    const input = await parseBody(req, applySuggestionSchema);
    return ok(await applySuggestion(ctx, projectId, assessmentId, input));
  });
}
