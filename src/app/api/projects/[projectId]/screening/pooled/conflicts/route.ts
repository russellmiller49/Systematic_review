import { handleRoute, ok, parseBody } from "@/server/api-utils";
import { getCtx } from "@/server/auth/session";
import {
  listPooledConflicts,
  pooledConflictsQuerySchema,
  adjudicatePooledConflict,
  adjudicatePooledConflictSchema,
} from "@/server/services/screening/pooled-adjudication";
type Params = { params: Promise<{ projectId: string }> };
export async function GET(req: Request, { params }: Params) {
  return handleRoute(async () => {
    const ctx = await getCtx();
    const { projectId } = await params;
    return ok(
      await listPooledConflicts(
        ctx,
        projectId,
        pooledConflictsQuerySchema.parse(
          Object.fromEntries(new URL(req.url).searchParams),
        ),
      ),
    );
  });
}
export async function POST(req: Request, { params }: Params) {
  return handleRoute(async () => {
    const ctx = await getCtx();
    const { projectId } = await params;
    return ok(
      await adjudicatePooledConflict(
        ctx,
        projectId,
        await parseBody(req, adjudicatePooledConflictSchema),
      ),
    );
  });
}
