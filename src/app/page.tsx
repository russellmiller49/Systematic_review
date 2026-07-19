import Link from "next/link";
import { redirect } from "next/navigation";
import { BookOpenCheck, GitBranch, PlayCircle, ShieldCheck, Users } from "lucide-react";
import { auth } from "@/server/auth";
import { buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export default async function LandingPage() {
  const session = await auth();
  if (session?.user?.id) redirect("/orgs");

  return (
    <main className="mx-auto flex min-h-screen max-w-4xl flex-col justify-center gap-10 px-6 py-16">
      <div className="space-y-4">
        <div className="flex items-center gap-2 text-primary">
          <BookOpenCheck className="h-7 w-7" />
          <span className="text-xl font-semibold tracking-tight">Synthesis</span>
        </div>
        <h1 className="text-4xl font-bold tracking-tight">
          The evidence synthesis operating system
        </h1>
        <p className="max-w-2xl text-lg text-muted-foreground">
          Protocols, screening, extraction, risk of bias, and PRISMA reporting — with every
          decision traceable back to the source evidence and the human judgment that produced it.
        </p>
        <div className="flex flex-wrap gap-3 pt-2">
          <Link href="/sign-up" className={cn(buttonVariants({ size: "lg" }), "px-6")}>
            Create an account
          </Link>
          <Link
            href="/sign-in"
            className={cn(buttonVariants({ size: "lg", variant: "outline" }), "px-6")}
          >
            Sign in
          </Link>
          <Link
            href="/guide#overview-video"
            className={cn(buttonVariants({ size: "lg", variant: "ghost" }), "px-5")}
          >
            <PlayCircle /> Watch overview
          </Link>
        </div>
      </div>
      <div className="grid gap-4 sm:grid-cols-3">
        <div className="rounded-lg border border-border p-4">
          <Users className="mb-2 h-5 w-5 text-primary" />
          <p className="font-medium">Blinded dual screening</p>
          <p className="text-sm text-muted-foreground">
            Independent reviewers, automatic conflict detection, recorded adjudication.
          </p>
        </div>
        <div className="rounded-lg border border-border p-4">
          <GitBranch className="mb-2 h-5 w-5 text-primary" />
          <p className="font-medium">Versioned protocols</p>
          <p className="text-sm text-muted-foreground">
            Amendments are first-class: changes after screening begins are logged, never silent.
          </p>
        </div>
        <div className="rounded-lg border border-border p-4">
          <ShieldCheck className="mb-2 h-5 w-5 text-primary" />
          <p className="font-medium">Complete audit trail</p>
          <p className="text-sm text-muted-foreground">
            Every import, decision, merge, and edit — who, what, when, and why.
          </p>
        </div>
      </div>
    </main>
  );
}
