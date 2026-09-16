import type { DefaultSession } from "next-auth";

declare module "next-auth" {
  interface User {
    passwordVersion?: string | null;
  }

  interface Session {
    user: {
      id: string;
    } & DefaultSession["user"];
  }
}
