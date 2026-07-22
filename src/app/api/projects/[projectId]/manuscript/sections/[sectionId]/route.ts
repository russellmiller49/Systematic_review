import { handleRoute, ok, parseBody } from "@/server/api-utils";
import { getCtx } from "@/server/auth/session";
import {
  deleteSection,
  getSection,
  updateSection,
  updateSectionSchema,
} from "@/server/services/manuscript";

type Params = { params: Promise<{ projectId: string; sectionId: string }> };

export async function GET(_req: Request, { params }: Params) {
  return handleRoute(async () => {
    const ctx = await getCtx();
    const { projectId, sectionId } = await params;
    return ok(await getSection(ctx, projectId, sectionId));
  });
}

export async function PATCH(req: Request, { params }: Params) {
  return handleRoute(async () => {
    const ctx = await getCtx();
    const { projectId, sectionId } = await params;
    const input = await parseBody(req, updateSectionSchema);
    return ok(await updateSection(ctx, projectId, sectionId, input));
  });
}

export async function DELETE(_req: Request, { params }: Params) {
  return handleRoute(async () => {
    const ctx = await getCtx();
    const { projectId, sectionId } = await params;
    return ok(await deleteSection(ctx, projectId, sectionId));
  });
}
