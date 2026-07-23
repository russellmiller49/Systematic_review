import { handleRoute, ok, parseBody } from "@/server/api-utils";
import { getCtx } from "@/server/auth/session";
import {
  convertProjectToSubProject,
  convertSubProjectSchema,
  listConvertibleProjects,
} from "@/server/services/projects";

type Params = { params: Promise<{ projectId: string }> };

export async function GET(_req: Request, { params }: Params) {
  return handleRoute(async () => {
    const ctx = await getCtx();
    const { projectId } = await params;
    return ok(await listConvertibleProjects(ctx, projectId));
  });
}

export async function POST(req: Request, { params }: Params) {
  return handleRoute(async () => {
    const ctx = await getCtx();
    const { projectId } = await params;
    const input = await parseBody(req, convertSubProjectSchema);
    return ok(await convertProjectToSubProject(ctx, projectId, input));
  });
}
