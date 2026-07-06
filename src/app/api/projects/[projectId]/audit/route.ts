import { handleRoute, ok } from "@/server/api-utils";
import { getCtx } from "@/server/auth/session";
import { listAuditEvents, listAuditEventsSchema } from "@/server/services/audit-query";

// Next.js 15: params is a Promise.
type Params = { params: Promise<{ projectId: string }> };

export async function GET(req: Request, { params }: Params) {
  return handleRoute(async () => {
    const ctx = await getCtx();
    const { projectId } = await params;
    const sp = new URL(req.url).searchParams;
    const input = listAuditEventsSchema.parse({
      entityType: sp.get("entityType") ?? undefined,
      entityId: sp.get("entityId") ?? undefined,
      userId: sp.get("userId") ?? undefined,
      actionPrefix: sp.get("actionPrefix") ?? undefined,
      from: sp.get("from") ?? undefined,
      to: sp.get("to") ?? undefined,
      cursor: sp.get("cursor") ?? undefined,
      limit: sp.get("limit") ?? undefined,
    });
    return ok(await listAuditEvents(ctx, projectId, input));
  });
}
