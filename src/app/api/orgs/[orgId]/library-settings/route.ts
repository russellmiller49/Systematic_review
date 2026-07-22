import { handleRoute, ok, parseBody } from "@/server/api-utils";
import { getCtx } from "@/server/auth/session";
import {
  getLibrarySettings,
  updateLibrarySettings,
  updateLibrarySettingsSchema,
} from "@/server/services/orgs";

type Params = { params: Promise<{ orgId: string }> };

export async function GET(_req: Request, { params }: Params) {
  return handleRoute(async () => {
    const ctx = await getCtx();
    const { orgId } = await params;
    return ok(await getLibrarySettings(ctx, orgId));
  });
}

export async function PUT(req: Request, { params }: Params) {
  return handleRoute(async () => {
    const ctx = await getCtx();
    const { orgId } = await params;
    const input = await parseBody(req, updateLibrarySettingsSchema);
    return ok(await updateLibrarySettings(ctx, orgId, input));
  });
}
