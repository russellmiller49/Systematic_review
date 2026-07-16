import { handleRoute, ok, parseBody } from "@/server/api-utils";
import { getCtx } from "@/server/auth/session";
import {
  reanchorExtractionEvidence,
  reanchorSchema,
} from "@/server/services/extraction/reanchor";

type Params = { params: Promise<{ projectId: string }> };

// Backfill v2 sourceAnchors for quoted extraction values (optionally one template).
// Returns the coverage report {total, exact, fuzzy, pageOnly, noPdf, noTextLayer}.
export async function POST(req: Request, { params }: Params) {
  return handleRoute(async () => {
    const ctx = await getCtx();
    const { projectId } = await params;
    const input = await parseBody(req, reanchorSchema);
    return ok(await reanchorExtractionEvidence(ctx, projectId, input));
  });
}
