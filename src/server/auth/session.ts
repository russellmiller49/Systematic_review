import { auth } from "@/server/auth";
import { unauthenticated } from "@/server/errors";

// Actor context threaded through every service call. The userId ALWAYS comes from the
// session — services never trust client-supplied user IDs.
export interface Ctx {
  userId: string;
}

export async function getCtx(): Promise<Ctx> {
  const session = await auth();
  const userId = session?.user?.id;
  if (!userId) throw unauthenticated();
  return { userId };
}

export async function getOptionalCtx(): Promise<Ctx | null> {
  const session = await auth();
  const userId = session?.user?.id;
  return userId ? { userId } : null;
}
