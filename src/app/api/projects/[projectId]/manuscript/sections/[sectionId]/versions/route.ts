import { created, handleRoute, ok, parseBody } from "@/server/api-utils";
import { getCtx } from "@/server/auth/session";
import {
  createVersion,
  createVersionSchema,
  listVersions,
} from "@/server/services/manuscript";

type Params = { params: Promise<{ projectId: string; sectionId: string }> };

export async function GET(_req: Request, { params }: Params) {
  return handleRoute(async () => {
    const ctx = await getCtx();
    const { projectId, sectionId } = await params;
    return ok(await listVersions(ctx, projectId, sectionId));
  });
}

export async function POST(req: Request, { params }: Params) {
  return handleRoute(async () => {
    const ctx = await getCtx();
    const { projectId, sectionId } = await params;
    const input = await parseBody(req, createVersionSchema).catch(() => ({}));
    return created(await createVersion(ctx, projectId, sectionId, input));
  });
}
