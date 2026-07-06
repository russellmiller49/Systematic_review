import { handleRoute, created, parseBody } from "@/server/api-utils";
import { getCtx } from "@/server/auth/session";
import { createQuestion, createQuestionSchema } from "@/server/services/rob";

type Params = { params: Promise<{ projectId: string; toolId: string; domainId: string }> };

export async function POST(req: Request, { params }: Params) {
  return handleRoute(async () => {
    const ctx = await getCtx();
    const { projectId, toolId, domainId } = await params;
    const input = await parseBody(req, createQuestionSchema);
    return created(await createQuestion(ctx, projectId, toolId, domainId, input));
  });
}
