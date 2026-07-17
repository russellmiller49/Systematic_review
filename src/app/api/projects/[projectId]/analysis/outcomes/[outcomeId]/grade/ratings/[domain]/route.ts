import { handleRoute, ok, parseBody } from "@/server/api-utils";
import { getCtx } from "@/server/auth/session";
import {
  parseGradeDomainParam,
  updateDomainRating,
  updateRatingSchema,
} from "@/server/services/grade";

type Params = { params: Promise<{ projectId: string; outcomeId: string; domain: string }> };

// Human edit or server-authoritative AI-suggestion apply for one domain rating.
export async function PATCH(req: Request, { params }: Params) {
  return handleRoute(async () => {
    const ctx = await getCtx();
    const { projectId, outcomeId, domain } = await params;
    const input = await parseBody(req, updateRatingSchema);
    return ok(
      await updateDomainRating(ctx, projectId, outcomeId, parseGradeDomainParam(domain), input),
    );
  });
}
