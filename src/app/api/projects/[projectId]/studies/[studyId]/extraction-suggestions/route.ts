import { created, handleRoute, ok, parseBody } from "@/server/api-utils";
import { getCtx } from "@/server/auth/session";
import {
  listSuggestions,
  listSuggestionsQuerySchema,
  runExtractionSuggestion,
  runSuggestionSchema,
} from "@/server/services/ai-extraction";

type Params = { params: Promise<{ projectId: string; studyId: string }> };

// AI suggestions for one (study, template) — ?templateId=.
export async function GET(req: Request, { params }: Params) {
  return handleRoute(async () => {
    const ctx = await getCtx();
    const { projectId, studyId } = await params;
    const url = new URL(req.url);
    const query = listSuggestionsQuerySchema.parse({
      templateId: url.searchParams.get("templateId") ?? undefined,
    });
    return ok(await listSuggestions(ctx, projectId, studyId, query));
  });
}

// Synchronous AI read of the study's PDF — can take a while for long documents; the
// client holds a spinner. See the JobRunner seam note in the service.
export async function POST(req: Request, { params }: Params) {
  return handleRoute(async () => {
    const ctx = await getCtx();
    const { projectId, studyId } = await params;
    const input = await parseBody(req, runSuggestionSchema);
    return created(await runExtractionSuggestion(ctx, projectId, studyId, input));
  });
}
