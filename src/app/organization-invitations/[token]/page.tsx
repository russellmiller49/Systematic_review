import Link from "next/link";
import { BookOpenCheck, Building2 } from "lucide-react";
import { auth } from "@/server/auth";
import { cn } from "@/lib/utils";
import { buttonVariants } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { AcceptOrganizationInvitationCard } from "@/components/invitations/accept-organization-invitation-card";

type Props = { params: Promise<{ token: string }> };

export default async function OrganizationInvitationPage({ params }: Props) {
  const { token } = await params;
  const session = await auth();
  const callbackUrl = `/organization-invitations/${encodeURIComponent(token)}`;

  return (
    <main className="flex min-h-screen flex-col bg-muted/40">
      <header className="flex h-14 items-center border-b border-border bg-background px-4">
        <Link
          href={session?.user?.id ? "/orgs" : "/"}
          className="flex items-center gap-2 text-primary"
        >
          <BookOpenCheck className="h-5 w-5" />
          <span className="font-semibold tracking-tight">Synthesis</span>
        </Link>
      </header>
      <div className="flex flex-1 items-center justify-center px-4 py-12">
        {session?.user?.id ? (
          <AcceptOrganizationInvitationCard
            token={token}
            email={session.user.email ?? "your account"}
          />
        ) : (
          <Card className="w-full max-w-lg">
            <CardHeader>
              <div className="mb-2 flex h-10 w-10 items-center justify-center rounded-full bg-primary/10 text-primary">
                <Building2 className="h-5 w-5" />
              </div>
              <CardTitle>You have been invited to an organization</CardTitle>
              <CardDescription>
                Sign in with the invited email address, or create an account with that address,
                to join the workspace and begin creating projects.
              </CardDescription>
            </CardHeader>
            <CardContent className="flex flex-col gap-3 sm:flex-row">
              <Link
                href={`/sign-in?callbackUrl=${encodeURIComponent(callbackUrl)}`}
                className={cn(buttonVariants(), "flex-1")}
              >
                Sign in
              </Link>
              <Link
                href={`/sign-up?callbackUrl=${encodeURIComponent(callbackUrl)}`}
                className={cn(buttonVariants({ variant: "outline" }), "flex-1")}
              >
                Create account
              </Link>
            </CardContent>
          </Card>
        )}
      </div>
    </main>
  );
}
