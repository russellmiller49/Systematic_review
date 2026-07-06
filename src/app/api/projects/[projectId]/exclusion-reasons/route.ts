import { created, handleRoute, ok, parseBody } from "@/server/api-utils";
import { getCtx } from "@/server/auth/session";
import {
  createExclusionReason,
  createExclusionReasonSchema,
  listExclusionReasons,
  listExclusionReasonsQuerySchema,
} from "@/server/services/protocols";

type Params = { params: Promise<{ projectId: string }> };

// ?stage=TITLE_ABSTRACT|FULL_TEXT|BOTH (applicability filter), ?includeInactive=true
export async function GET(req: Request, { params }: Params) {
  return handleRoute(async () => {
    const ctx = await getCtx();
    const { projectId } = await params;
    const url = new URL(req.url);
    const query = listExclusionReasonsQuerySchema.parse({
      stage: url.searchParams.get("stage") ?? undefined,
      includeInactive: url.searchParams.get("includeInactive") ?? undefined,
    });
    return ok(await listExclusionReasons(ctx, projectId, query));
  });
}

export async function POST(req: Request, { params }: Params) {
  return handleRoute(async () => {
    const ctx = await getCtx();
    const { projectId } = await params;
    const input = await parseBody(req, createExclusionReasonSchema);
    return created(await createExclusionReason(ctx, projectId, input));
  });
}
