import { handleRoute, ok, created, parseBody } from "@/server/api-utils";
import { getCtx } from "@/server/auth/session";
import {
  listRetrievalAttempts,
  recordRetrievalAttempt,
  recordRetrievalAttemptSchema,
} from "@/server/services/fulltext";

// Next.js 15: params is a Promise.
type Params = { params: Promise<{ projectId: string; citationId: string }> };

// GET → retrieval attempts for the citation (with recorder names).
export async function GET(_req: Request, { params }: Params) {
  return handleRoute(async () => {
    const ctx = await getCtx();
    const { projectId, citationId } = await params;
    return ok(await listRetrievalAttempts(ctx, projectId, citationId));
  });
}

// POST { method, outcome, notes? } → record an attempt ("mark unavailable" = NOT_RETRIEVED).
export async function POST(req: Request, { params }: Params) {
  return handleRoute(async () => {
    const ctx = await getCtx();
    const { projectId, citationId } = await params;
    const input = await parseBody(req, recordRetrievalAttemptSchema);
    return created(await recordRetrievalAttempt(ctx, projectId, citationId, input));
  });
}
