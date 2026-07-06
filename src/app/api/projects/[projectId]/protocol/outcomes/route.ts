import { created, handleRoute, parseBody } from "@/server/api-utils";
import { getCtx } from "@/server/auth/session";
import { createOutcome, createOutcomeSchema } from "@/server/services/protocols";

type Params = { params: Promise<{ projectId: string }> };

export async function POST(req: Request, { params }: Params) {
  return handleRoute(async () => {
    const ctx = await getCtx();
    const { projectId } = await params;
    const input = await parseBody(req, createOutcomeSchema);
    return created(await createOutcome(ctx, projectId, input));
  });
}
