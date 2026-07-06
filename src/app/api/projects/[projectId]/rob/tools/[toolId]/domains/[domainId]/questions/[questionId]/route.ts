import { handleRoute, ok, parseBody } from "@/server/api-utils";
import { getCtx } from "@/server/auth/session";
import { deleteQuestion, updateQuestion, updateQuestionSchema } from "@/server/services/rob";

type Params = {
  params: Promise<{ projectId: string; toolId: string; domainId: string; questionId: string }>;
};

export async function PATCH(req: Request, { params }: Params) {
  return handleRoute(async () => {
    const ctx = await getCtx();
    const { projectId, toolId, domainId, questionId } = await params;
    const input = await parseBody(req, updateQuestionSchema);
    return ok(await updateQuestion(ctx, projectId, toolId, domainId, questionId, input));
  });
}

export async function DELETE(_req: Request, { params }: Params) {
  return handleRoute(async () => {
    const ctx = await getCtx();
    const { projectId, toolId, domainId, questionId } = await params;
    return ok(await deleteQuestion(ctx, projectId, toolId, domainId, questionId));
  });
}
