import { created, handleRoute, ok, parseBody } from "@/server/api-utils";
import { getCtx } from "@/server/auth/session";
import {
  listRobSuggestions,
  listRobSuggestionsQuerySchema,
  runRobSuggestion,
  runRobSuggestionSchema,
} from "@/server/services/ai-rob";

type Params = { params: Promise<{ projectId: string; studyId: string }> };

// AI RoB suggestions for one (study, tool) — ?toolId=.
export async function GET(req: Request, { params }: Params) {
  return handleRoute(async () => {
    const ctx = await getCtx();
    const { projectId, studyId } = await params;
    const url = new URL(req.url);
    const query = listRobSuggestionsQuerySchema.parse({
      toolId: url.searchParams.get("toolId") ?? undefined,
    });
    return ok(await listRobSuggestions(ctx, projectId, studyId, query));
  });
}

// Synchronous AI read of the study's PDF — can take a while for long documents; the
// client holds a spinner. See the JobRunner seam note in the service.
export async function POST(req: Request, { params }: Params) {
  return handleRoute(async () => {
    const ctx = await getCtx();
    const { projectId, studyId } = await params;
    const input = await parseBody(req, runRobSuggestionSchema);
    return created(await runRobSuggestion(ctx, projectId, studyId, input));
  });
}
