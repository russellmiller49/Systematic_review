import { handleRoute, ok, parseBody } from "@/server/api-utils";
import { getCtx } from "@/server/auth/session";
import {
  removeProjectMember,
  updateProjectMemberRoles,
  updateProjectMemberRolesSchema,
} from "@/server/services/projects";

// Next.js 15: params is a Promise.
type Params = { params: Promise<{ projectId: string; userId: string }> };

export async function PATCH(req: Request, { params }: Params) {
  return handleRoute(async () => {
    const ctx = await getCtx();
    const { projectId, userId } = await params;
    const input = await parseBody(req, updateProjectMemberRolesSchema);
    return ok(await updateProjectMemberRoles(ctx, projectId, userId, input));
  });
}

export async function DELETE(_req: Request, { params }: Params) {
  return handleRoute(async () => {
    const ctx = await getCtx();
    const { projectId, userId } = await params;
    return ok(await removeProjectMember(ctx, projectId, userId));
  });
}
