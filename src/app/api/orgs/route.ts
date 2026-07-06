// EXEMPLAR ROUTE — thin controller: parse → session → service → envelope.
import { handleRoute, ok, created, parseBody } from "@/server/api-utils";
import { getCtx } from "@/server/auth/session";
import { createOrg, createOrgSchema, listMyOrgs } from "@/server/services/orgs";

export async function GET() {
  return handleRoute(async () => {
    const ctx = await getCtx();
    return ok(await listMyOrgs(ctx));
  });
}

export async function POST(req: Request) {
  return handleRoute(async () => {
    const ctx = await getCtx();
    const input = await parseBody(req, createOrgSchema);
    return created(await createOrg(ctx, input));
  });
}
