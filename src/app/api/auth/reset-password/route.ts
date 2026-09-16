import { handleRoute, ok, parseBody } from "@/server/api-utils";
import { resetPassword, resetPasswordSchema } from "@/server/services/users/password-reset";

export async function POST(req: Request) {
  return handleRoute(async () => {
    const input = await parseBody(req, resetPasswordSchema);
    await resetPassword(input);
    return ok({ message: "Password updated. Sign in with your new password." }, { headers: { "Cache-Control": "no-store" } });
  });
}
