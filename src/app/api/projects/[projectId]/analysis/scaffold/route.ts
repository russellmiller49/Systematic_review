import { created, handleRoute, parseBody } from "@/server/api-utils";
import { getCtx } from "@/server/auth/session";
import {
  scaffoldOutcomeFields,
  scaffoldOutcomeSchema,
} from "@/server/services/analysis/scaffold";

type Params = { params: Promise<{ projectId: string }> };

// Scaffold a measure's NUMBER fields on a DRAFT extraction template plus the analysis
// outcome and its role mappings, in one transaction (analysis.manage + extraction.templates).
export async function POST(req: Request, { params }: Params) {
  return handleRoute(async () => {
    const ctx = await getCtx();
    const { projectId } = await params;
    const input = await parseBody(req, scaffoldOutcomeSchema);
    return created(await scaffoldOutcomeFields(ctx, projectId, input));
  });
}
