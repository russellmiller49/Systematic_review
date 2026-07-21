"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Building2 } from "lucide-react";
import { apiPost, ApiError } from "@/lib/api";
import { Alert, Spinner } from "@/components/ui/misc";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

interface InvitationResult {
  organization: { id: string; name: string };
}

export function AcceptOrganizationInvitationCard({
  token,
  email,
}: {
  token: string;
  email: string;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function accept() {
    setBusy(true);
    setError(null);
    try {
      const result = await apiPost<InvitationResult>(
        `/api/organization-invitations/${encodeURIComponent(token)}/accept`,
      );
      router.push(`/orgs/${result.organization.id}`);
      router.refresh();
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : "Could not accept this invitation");
      setBusy(false);
    }
  }

  return (
    <Card className="w-full max-w-lg">
      <CardHeader>
        <div className="mb-2 flex h-10 w-10 items-center justify-center rounded-full bg-primary/10 text-primary">
          <Building2 className="h-5 w-5" />
        </div>
        <CardTitle>Join the organization</CardTitle>
        <CardDescription>
          Accept the invitation to join this workspace. You can then create projects and will
          have full Owner access to every project you create.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <p className="text-sm text-muted-foreground">
          Signed in as <span className="font-medium text-foreground">{email}</span>. The email on
          your account must match the invited address.
        </p>
        {error && <Alert variant="error">{error}</Alert>}
        <Button onClick={accept} disabled={busy} className="w-full">
          {busy && <Spinner />} Accept organization invitation
        </Button>
      </CardContent>
    </Card>
  );
}
