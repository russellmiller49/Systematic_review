import { created, handleRoute } from "@/server/api-utils";
import { getCtx } from "@/server/auth/session";
import { runGradeSuggestion } from "@/server/services/ai-grade";

type Params = { params: Promise<{ projectId: string; outcomeId: string }> };

// Synchronous text-only AI call drafting per-domain GRADE prose suggestions — the client
// holds a spinner. The latest run + suggestions are read back through GET …/grade
// (getGradeView); there is no separate GET here.
export async function POST(_req: Request, { params }: Params) {
  return handleRoute(async () => {
    const ctx = await getCtx();
    const { projectId, outcomeId } = await params;
    return created(await runGradeSuggestion(ctx, projectId, outcomeId));
  });
}
