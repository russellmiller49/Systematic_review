import { handleRoute, ok, created, parseBody } from "@/server/api-utils";
import { getCtx } from "@/server/auth/session";
import {
  createInvitation,
  createInvitationSchema,
  listInvitations,
} from "@/server/services/projects";

// Next.js 15: params is a Promise.
type Params = { params: Promise<{ projectId: string }> };

export async function GET(_req: Request, { params }: Params) {
  return handleRoute(async () => {
    const ctx = await getCtx();
    const { projectId } = await params;
    return ok(await listInvitations(ctx, projectId));
  });
}

// R11: the response of THIS call is the only place the invitation token ever appears.
export async function POST(req: Request, { params }: Params) {
  return handleRoute(async () => {
    const ctx = await getCtx();
    const { projectId } = await params;
    const input = await parseBody(req, createInvitationSchema);
    return created(await createInvitation(ctx, projectId, input));
  });
}
