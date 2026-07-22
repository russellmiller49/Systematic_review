import { created, handleRoute, ok, parseBody } from "@/server/api-utils";
import { getCtx } from "@/server/auth/session";
import {
  createReference,
  createReferenceSchema,
  listReferences,
  listReferencesSchema,
} from "@/server/services/references";

type Params = { params: Promise<{ projectId: string }> };

export async function GET(req: Request, { params }: Params) {
  return handleRoute(async () => {
    const ctx = await getCtx();
    const { projectId } = await params;
    const url = new URL(req.url);
    const filter = listReferencesSchema.parse(Object.fromEntries(url.searchParams));
    return ok(await listReferences(ctx, projectId, filter));
  });
}

export async function POST(req: Request, { params }: Params) {
  return handleRoute(async () => {
    const ctx = await getCtx();
    const { projectId } = await params;
    const input = await parseBody(req, createReferenceSchema);
    return created(await createReference(ctx, projectId, input));
  });
}
