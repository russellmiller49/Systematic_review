import { handleRoute, created, ok, parseBody } from "@/server/api-utils";
import { getCtx } from "@/server/auth/session";
import {
  createAssignments,
  createAssignmentsSchema,
  listAssignmentAdmin,
  resetPendingAssignments,
  resetPendingAssignmentsSchema,
} from "@/server/services/screening";

type Params = { params: Promise<{ projectId: string; stageId: string }> };

export async function GET(_req: Request, { params }: Params) {
  return handleRoute(async () => {
    const ctx = await getCtx();
    const { projectId, stageId } = await params;
    return ok(await listAssignmentAdmin(ctx, projectId, stageId));
  });
}

export async function POST(req: Request, { params }: Params) {
  return handleRoute(async () => {
    const ctx = await getCtx();
    const { projectId, stageId } = await params;
    const input = await parseBody(req, createAssignmentsSchema);
    return created(await createAssignments(ctx, projectId, stageId, input));
  });
}

export async function DELETE(req: Request, { params }: Params) {
  return handleRoute(async () => {
    const ctx = await getCtx();
    const { projectId, stageId } = await params;
    const input = await parseBody(req, resetPendingAssignmentsSchema);
    return ok(await resetPendingAssignments(ctx, projectId, stageId, input));
  });
}
