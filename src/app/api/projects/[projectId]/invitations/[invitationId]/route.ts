import { handleRoute, ok } from "@/server/api-utils";
import { getCtx } from "@/server/auth/session";
import { revokeInvitation } from "@/server/services/projects";

// Next.js 15: params is a Promise.
type Params = { params: Promise<{ projectId: string; invitationId: string }> };

export async function DELETE(_req: Request, { params }: Params) {
  return handleRoute(async () => {
    const ctx = await getCtx();
    const { projectId, invitationId } = await params;
    return ok(await revokeInvitation(ctx, projectId, invitationId));
  });
}
