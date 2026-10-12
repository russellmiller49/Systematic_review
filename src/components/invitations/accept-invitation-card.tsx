"use client";

import { useState } from "react";
import { signOut } from "next-auth/react";
import { useRouter } from "next/navigation";
import { MailCheck } from "lucide-react";
import { apiPost, ApiError } from "@/lib/api";
import { Alert, Spinner } from "@/components/ui/misc";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

interface InvitationResult {
  project: { id: string; title: string };
}

export function AcceptInvitationCard({ token, email }: { token: string; email: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function accept() {
    setBusy(true);
    setError(null);
    try {
      const result = await apiPost<InvitationResult>(
        `/api/invitations/${encodeURIComponent(token)}/accept`,
      );
      router.push(`/projects/${result.project.id}`);
      router.refresh();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not accept this invitation");
      setBusy(false);
    }
  }

  return (
    <Card className="w-full max-w-lg">
      <CardHeader>
        <div className="mb-2 flex h-10 w-10 items-center justify-center rounded-full bg-primary/10 text-primary">
          <MailCheck className="h-5 w-5" />
        </div>
        <CardTitle>Join the project</CardTitle>
        <CardDescription>
          Accept the invitation to add this project and its assigned role to your Synthesis account.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <p className="text-sm text-muted-foreground">
          Signed in as <span className="font-medium text-foreground">{email}</span>. The email on
          your account must match the address the owner invited.
        </p>
        <p className="text-sm text-muted-foreground">
          Different institutional domains are separate accounts. If the invitation was sent to a
          different address, sign in with that address or ask the project owner to verify the
          invitation. Workspace access, project roles, and screening targets are separate; accepting
          an invitation does not confirm which queue you should screen.
        </p>
        {error && <Alert variant="error">{error}</Alert>}
        <Button
          variant="outline"
          disabled={busy}
          className="w-full"
          onClick={() =>
            signOut({
              callbackUrl: `/sign-in?callbackUrl=${encodeURIComponent(`/invitations/${encodeURIComponent(token)}`)}`,
            })
          }
        >
          Sign in with a different account
        </Button>
        <Button onClick={accept} disabled={busy} className="w-full">
          {busy && <Spinner />} Accept invitation
        </Button>
      </CardContent>
    </Card>
  );
}
