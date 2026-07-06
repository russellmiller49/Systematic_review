import { created, handleRoute } from "@/server/api-utils";
import { getCtx } from "@/server/auth/session";
import { publishProtocol } from "@/server/services/protocols";

type Params = { params: Promise<{ projectId: string }> };

export async function POST(_req: Request, { params }: Params) {
  return handleRoute(async () => {
    const ctx = await getCtx();
    const { projectId } = await params;
    return created(await publishProtocol(ctx, projectId));
  });
}
