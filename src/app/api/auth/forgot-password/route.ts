import { handleRoute, ok, parseBody } from "@/server/api-utils";
import { forgotPasswordSchema, requestPasswordReset, RESET_REQUEST_MESSAGE } from "@/server/services/users/password-reset";

export async function POST(req: Request) {
  return handleRoute(async () => {
    const input = await parseBody(req, forgotPasswordSchema);
    await requestPasswordReset(input);
    return ok({ message: RESET_REQUEST_MESSAGE }, { headers: { "Cache-Control": "no-store" } });
  });
}
