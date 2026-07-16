import { created, handleRoute, ok, parseBody } from "@/server/api-utils";
import { getCtx } from "@/server/auth/session";
import {
  createOutcome,
  createOutcomeSchema,
  listOutcomes,
} from "@/server/services/analysis";

type Params = { params: Promise<{ projectId: string }> };

// Analysis outcomes: the meta-analyzable questions (effect measure + field mappings).
export async function GET(_req: Request, { params }: Params) {
  return handleRoute(async () => {
    const ctx = await getCtx();
    const { projectId } = await params;
    return ok(await listOutcomes(ctx, projectId));
  });
}

export async function POST(req: Request, { params }: Params) {
  return handleRoute(async () => {
    const ctx = await getCtx();
    const { projectId } = await params;
    const input = await parseBody(req, createOutcomeSchema);
    return created(await createOutcome(ctx, projectId, input));
  });
}
