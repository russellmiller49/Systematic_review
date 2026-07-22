import { handleRoute, ok, parseBody } from "@/server/api-utils";
import { getCtx } from "@/server/auth/session";
import {
  acquireLock,
  acquireLockSchema,
  heartbeatLock,
  releaseLock,
} from "@/server/services/manuscript";

type Params = { params: Promise<{ projectId: string; sectionId: string }> };

export async function POST(req: Request, { params }: Params) {
  return handleRoute(async () => {
    const ctx = await getCtx();
    const { projectId, sectionId } = await params;
    const input = await parseBody(req, acquireLockSchema).catch(() => ({}) as { takeover?: boolean });
    return ok(await acquireLock(ctx, projectId, sectionId, input));
  });
}

export async function PUT(_req: Request, { params }: Params) {
  return handleRoute(async () => {
    const ctx = await getCtx();
    const { projectId, sectionId } = await params;
    return ok(await heartbeatLock(ctx, projectId, sectionId));
  });
}

export async function DELETE(_req: Request, { params }: Params) {
  return handleRoute(async () => {
    const ctx = await getCtx();
    const { projectId, sectionId } = await params;
    return ok(await releaseLock(ctx, projectId, sectionId));
  });
}
