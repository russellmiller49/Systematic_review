import { handleRoute, ok } from "@/server/api-utils";
import { getCtx } from "@/server/auth/session";
import { findPdfForCitation } from "@/server/services/fulltext-retrieval";

type Params = { params: Promise<{ projectId: string; citationId: string }> };

export async function POST(_req: Request, { params }: Params) {
  return handleRoute(async () => {
    const ctx = await getCtx();
    const { projectId, citationId } = await params;
    return ok(await findPdfForCitation(ctx, projectId, citationId));
  });
}
