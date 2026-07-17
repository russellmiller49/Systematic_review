import { created, handleRoute, ok, parseBody } from "@/server/api-utils";
import { getCtx } from "@/server/auth/session";
import {
  generateDraft,
  generateDraftSchema,
  getGradeView,
  setStartingLevel,
  setStartingLevelSchema,
} from "@/server/services/grade";

type Params = { params: Promise<{ projectId: string; outcomeId: string }> };

// Assessment + ratings + staleness + AI suggestions for one outcome.
export async function GET(_req: Request, { params }: Params) {
  return handleRoute(async () => {
    const ctx = await getCtx();
    const { projectId, outcomeId } = await params;
    return ok(await getGradeView(ctx, projectId, outcomeId));
  });
}

// (Re)generate the deterministic Tier-1 draft; human-touched ratings are preserved.
export async function POST(req: Request, { params }: Params) {
  return handleRoute(async () => {
    const ctx = await getCtx();
    const { projectId, outcomeId } = await params;
    const input = await parseBody(req, generateDraftSchema);
    return created(await generateDraft(ctx, projectId, outcomeId, input));
  });
}

export async function PATCH(req: Request, { params }: Params) {
  return handleRoute(async () => {
    const ctx = await getCtx();
    const { projectId, outcomeId } = await params;
    const input = await parseBody(req, setStartingLevelSchema);
    return ok(await setStartingLevel(ctx, projectId, outcomeId, input));
  });
}
