// Built-in RoB tool catalog — session only (not project data).
import { handleRoute, ok } from "@/server/api-utils";
import { getCtx } from "@/server/auth/session";
import { listBuiltinTools } from "@/server/services/rob";

export async function GET() {
  return handleRoute(async () => {
    const ctx = await getCtx();
    return ok(await listBuiltinTools(ctx));
  });
}
