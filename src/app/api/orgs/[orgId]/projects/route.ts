import { handleRoute, ok, created, parseBody } from "@/server/api-utils";
import { getCtx } from "@/server/auth/session";
import { createProject, createProjectSchema, listProjects } from "@/server/services/projects";

// Next.js 15: params is a Promise.
type Params = { params: Promise<{ orgId: string }> };

export async function GET(_req: Request, { params }: Params) {
  return handleRoute(async () => {
    const ctx = await getCtx();
    const { orgId } = await params;
    return ok(await listProjects(ctx, orgId));
  });
}

export async function POST(req: Request, { params }: Params) {
  return handleRoute(async () => {
    const ctx = await getCtx();
    const { orgId } = await params;
    const input = await parseBody(req, createProjectSchema);
    return created(await createProject(ctx, orgId, input));
  });
}
