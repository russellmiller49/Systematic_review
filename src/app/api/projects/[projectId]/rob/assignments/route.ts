import { handleRoute, ok, created, parseBody } from "@/server/api-utils";
import { getCtx } from "@/server/auth/session";
import {
  createAssignments,
  createAssignmentsSchema,
  listAssignments,
} from "@/server/services/rob";

type Params = { params: Promise<{ projectId: string }> };

export async function GET(req: Request, { params }: Params) {
  return handleRoute(async () => {
    const ctx = await getCtx();
    const { projectId } = await params;
    const mine = new URL(req.url).searchParams.get("mine") === "true";
    return ok(await listAssignments(ctx, projectId, { mine }));
  });
}

export async function POST(req: Request, { params }: Params) {
  return handleRoute(async () => {
    const ctx = await getCtx();
    const { projectId } = await params;
    const input = await parseBody(req, createAssignmentsSchema);
    return created(await createAssignments(ctx, projectId, input));
  });
}
