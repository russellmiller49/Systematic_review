import { handleRoute, created, parseBody } from "@/server/api-utils";
import { createUser, signUpSchema } from "@/server/services/users";

export async function POST(req: Request) {
  return handleRoute(async () => {
    const input = await parseBody(req, signUpSchema);
    const user = await createUser(input);
    return created(user);
  });
}
