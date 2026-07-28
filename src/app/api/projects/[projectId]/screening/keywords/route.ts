import { created, handleRoute, ok, parseBody } from "@/server/api-utils";
import { getCtx } from "@/server/auth/session";
import {
  createScreeningKeywords,
  createScreeningKeywordsSchema,
  listScreeningKeywords,
} from "@/server/services/screening-keywords";

type Params = { params: Promise<{ projectId: string }> };

export async function GET(_req: Request, { params }: Params) {
  return handleRoute(async () => {
    const ctx = await getCtx();
    const { projectId } = await params;
    return ok(await listScreeningKeywords(ctx, projectId));
  });
}

export async function POST(req: Request, { params }: Params) {
  return handleRoute(async () => {
    const ctx = await getCtx();
    const { projectId } = await params;
    const input = await parseBody(req, createScreeningKeywordsSchema);
    return created(await createScreeningKeywords(ctx, projectId, input));
  });
}
