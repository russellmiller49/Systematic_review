import Link from "next/link";
import { redirect } from "next/navigation";
import { BookOpenCheck, BookOpenText } from "lucide-react";
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
        <div className="flex items-center gap-1">
          <Link
            href="/guide"
            className="inline-flex h-9 items-center gap-2 rounded-md px-3 text-sm text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          >
            <BookOpenText className="h-4 w-4" />
            <span className="hidden sm:inline">User guide</span>
          </Link>
          <UserMenu name={session.user.name ?? ""} email={session.user.email ?? ""} />
        </div>
      </header>
      <div className="flex flex-1">{children}</div>
    </div>
  );
}
