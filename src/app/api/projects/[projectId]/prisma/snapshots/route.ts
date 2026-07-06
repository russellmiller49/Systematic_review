import { handleRoute, ok, created, parseBody } from "@/server/api-utils";
import { getCtx } from "@/server/auth/session";
import {
  createPrismaSnapshot,
  createSnapshotSchema,
  listPrismaSnapshots,
} from "@/server/services/prisma-report";

// Next.js 15: params is a Promise.
type Params = { params: Promise<{ projectId: string }> };

export async function GET(_req: Request, { params }: Params) {
  return handleRoute(async () => {
    const ctx = await getCtx();
    const { projectId } = await params;
    return ok(await listPrismaSnapshots(ctx, projectId));
  });
}

export async function POST(req: Request, { params }: Params) {
  return handleRoute(async () => {
    const ctx = await getCtx();
    const { projectId } = await params;
    const input = await parseBody(req, createSnapshotSchema);
    return created(await createPrismaSnapshot(ctx, projectId, input));
  });
}
