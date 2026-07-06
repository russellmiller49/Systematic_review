import { handleRoute, created, parseBody } from "@/server/api-utils";
import { getCtx } from "@/server/auth/session";
import { linkFileToCitation, linkFileSchema } from "@/server/services/fulltext";

// Next.js 15: params is a Promise.
type Params = { params: Promise<{ projectId: string; fileId: string }> };

// POST { citationId, label? } → link an existing project file to another citation.
export async function POST(req: Request, { params }: Params) {
  return handleRoute(async () => {
    const ctx = await getCtx();
    const { projectId, fileId } = await params;
    const input = await parseBody(req, linkFileSchema);
    return created(await linkFileToCitation(ctx, projectId, fileId, input));
  });
}
