import { handleRoute, ok, parseBody } from "@/server/api-utils";
import { getCtx } from "@/server/auth/session";
import {
  previewWithdrawal,
  withdrawalPreviewSchema,
} from "@/server/services/screening/withdrawal";

export async function POST(
  req: Request,
  { params }: { params: Promise<{ projectId: string }> },
) {
  return handleRoute(async () =>
    ok(
      await previewWithdrawal(
        await getCtx(),
        (await params).projectId,
        await parseBody(req, withdrawalPreviewSchema),
      ),
    ),
  );
}
