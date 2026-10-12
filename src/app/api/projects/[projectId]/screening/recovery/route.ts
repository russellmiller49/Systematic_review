import { handleRoute, ok, parseBody } from "@/server/api-utils";
import { getCtx } from "@/server/auth/session";
import {
  executeRecovery,
  executeRecoverySchema,
  listWithdrawals,
} from "@/server/services/screening/withdrawal";

type Params = { params: Promise<{ projectId: string }> };
export async function GET(_req: Request, { params }: Params) {
  return handleRoute(async () =>
    ok(await listWithdrawals(await getCtx(), (await params).projectId)),
  );
}
export async function POST(req: Request, { params }: Params) {
  return handleRoute(async () => {
    const ctx = await getCtx();
    const { projectId } = await params;
    const { token } = await parseBody(req, executeRecoverySchema);
    return ok(await executeRecovery(ctx, projectId, token));
  });
}
