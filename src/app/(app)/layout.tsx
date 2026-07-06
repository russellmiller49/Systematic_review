import Link from "next/link";
import { redirect } from "next/navigation";
import { BookOpenCheck } from "lucide-react";
import { auth } from "@/server/auth";
import { UserMenu } from "@/components/layout/user-menu";

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const session = await auth();
  if (!session?.user?.id) redirect("/sign-in");

  return (
    <div className="flex min-h-screen flex-col">
      <header className="sticky top-0 z-40 flex h-14 items-center justify-between border-b border-border bg-background/95 px-4 backdrop-blur">
        <Link href="/orgs" className="flex items-center gap-2 text-primary">
          <BookOpenCheck className="h-5 w-5" />
          <span className="font-semibold tracking-tight">Synthesis</span>
        </Link>
        <UserMenu name={session.user.name ?? ""} email={session.user.email ?? ""} />
      </header>
      <div className="flex flex-1">{children}</div>
    </div>
  );
}
