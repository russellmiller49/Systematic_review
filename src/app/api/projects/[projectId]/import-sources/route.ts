import { created, handleRoute, ok, parseBody } from "@/server/api-utils";
import { getCtx } from "@/server/auth/session";
import {
  createImportSource,
  createImportSourceSchema,
  listImportSources,
} from "@/server/services/imports";

// Next.js 15: params is a Promise.
type Params = { params: Promise<{ projectId: string }> };

export async function GET(_req: Request, { params }: Params) {
  return handleRoute(async () => {
    const ctx = await getCtx();
    const { projectId } = await params;
    return ok(await listImportSources(ctx, projectId));
  });
}

export async function POST(req: Request, { params }: Params) {
  return handleRoute(async () => {
    const ctx = await getCtx();
    const { projectId } = await params;
    const input = await parseBody(req, createImportSourceSchema);
    return created(await createImportSource(ctx, projectId, input));
  });
}
