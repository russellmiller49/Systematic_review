"use client";

import { useCallback, useEffect, useState } from "react";
import { Copy, Mail, MailPlus } from "lucide-react";
import { toast } from "sonner";
import { api, apiDelete, apiPost, ApiError } from "@/lib/api";
import { formatDate } from "@/lib/utils";
import { Badge, type BadgeProps } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import { Alert, EmptyState, Skeleton, Spinner } from "@/components/ui/misc";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

const ORGANIZATION_ROLES = ["MEMBER", "ADMIN", "OWNER"] as const;
type OrganizationRole = (typeof ORGANIZATION_ROLES)[number];

const ROLE_LABELS: Record<OrganizationRole, string> = {
  MEMBER: "Member / beta tester",
  ADMIN: "Workspace admin",
  OWNER: "Workspace owner",
};

const ROLE_DESCRIPTIONS: Record<OrganizationRole, string> = {
  MEMBER:
    "Can create organizations and projects. They become Owner of every project they create, but cannot open or work in other projects unless separately added.",
  ADMIN:
    "Can create projects and manage this workspace's members and invitations. Existing projects still require separate project membership.",
  OWNER:
    "Full workspace ownership, including member and invitation management. Use only for a trusted co-owner.",
};

export function organizationRoleLabel(role: string): string {
  return (ROLE_LABELS as Record<string, string>)[role] ?? role.toLowerCase();
}

// List responses intentionally omit the token; it appears only in the create response.
interface InvitationRow {
  id: string;
  email: string;
  role: OrganizationRole;
  expiresAt: string;
  acceptedAt: string | null;
  revokedAt: string | null;
  createdAt: string;
  invitedBy: { id: string; name: string; email: string };
}

interface CreatedInvitation {
  id: string;
  email: string;
  role: OrganizationRole;
  token: string;
  expiresAt: string;
}

function invitationStatus(invitation: InvitationRow): {
  label: string;
  variant: BadgeProps["variant"];
  pending: boolean;
} {
  if (invitation.revokedAt) return { label: "revoked", variant: "exclude", pending: false };
  if (invitation.acceptedAt) return { label: "accepted", variant: "include", pending: false };
  if (new Date(invitation.expiresAt).getTime() < Date.now()) {
    return { label: "expired", variant: "muted", pending: false };
  }
  return { label: "pending", variant: "maybe", pending: true };
}

export function OrganizationInvitationsSection({ orgId }: { orgId: string }) {
  const [invitations, setInvitations] = useState<InvitationRow[] | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<OrganizationRole>("MEMBER");
  const [creating, setCreating] = useState(false);
  const [created, setCreated] = useState<CreatedInvitation | null>(null);
  const [revokeTarget, setRevokeTarget] = useState<InvitationRow | null>(null);
  const [revoking, setRevoking] = useState(false);

  const load = useCallback(() => {
    api<InvitationRow[]>(`/api/orgs/${orgId}/invitations`)
      .then(setInvitations)
      .catch(() => {
        toast.error("Failed to load organization invitations");
        setInvitations([]);
      });
  }, [orgId]);

  useEffect(load, [load]);

  async function createInvitation(event: React.FormEvent) {
    event.preventDefault();
    setCreating(true);
    try {
      const invitation = await apiPost<CreatedInvitation>(`/api/orgs/${orgId}/invitations`, {
        email: email.trim(),
        role,
      });
      toast.success("Organization invitation created");
      setCreateOpen(false);
      setEmail("");
      setRole("MEMBER");
      setCreated(invitation);
      load();
    } catch (error) {
      toast.error(error instanceof ApiError ? error.message : "Failed to create invitation");
    } finally {
      setCreating(false);
    }
  }

  async function copyInvitationLink() {
    if (!created) return;
    try {
      const path = `/organization-invitations/${encodeURIComponent(created.token)}`;
      await navigator.clipboard.writeText(new URL(path, window.location.origin).toString());
      toast.success("Invitation link copied to clipboard");
    } catch {
      toast.error("Could not copy — select the invitation link manually");
    }
  }

  async function revokeInvitation() {
    if (!revokeTarget) return;
    setRevoking(true);
    try {
      await apiDelete(`/api/orgs/${orgId}/invitations/${revokeTarget.id}`);
      toast.success("Invitation revoked");
      setRevokeTarget(null);
      load();
    } catch (error) {
      toast.error(error instanceof ApiError ? error.message : "Failed to revoke invitation");
    } finally {
      setRevoking(false);
    }
  }

  return (
    <section className="space-y-3">
      <div className="flex items-center justify-between gap-4">
        <div>
          <h2 className="text-lg font-medium">Organization invitations</h2>
          <p className="text-sm text-muted-foreground">
            Invite new or existing users to this workspace and unlock pilot signup for their
            email.
          </p>
        </div>
        <Dialog open={createOpen} onOpenChange={setCreateOpen}>
          <DialogTrigger asChild>
            <Button variant="outline" size="sm">
              <MailPlus /> Invite member
            </Button>
          </DialogTrigger>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Invite to organization</DialogTitle>
              <DialogDescription>
                The invitee can create an account with this email, join the workspace, and use
                the access level you select.
              </DialogDescription>
            </DialogHeader>
            <form onSubmit={createInvitation} className="space-y-4">
              <div className="space-y-1.5">
                <Label htmlFor="org-invitation-email">Email</Label>
                <Input
                  id="org-invitation-email"
                  type="email"
                  required
                  value={email}
                  onChange={(event) => setEmail(event.target.value)}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="org-invitation-role">Access level</Label>
                <Select
                  id="org-invitation-role"
                  value={role}
                  onChange={(event) => setRole(event.target.value as OrganizationRole)}
                >
                  {ORGANIZATION_ROLES.map((value) => (
                    <option key={value} value={value}>
                      {ROLE_LABELS[value]}
                    </option>
                  ))}
                </Select>
                <p className="text-xs leading-relaxed text-muted-foreground">
                  {ROLE_DESCRIPTIONS[role]}
                </p>
              </div>
              <DialogFooter>
                <Button type="submit" disabled={creating}>
                  {creating && <Spinner />} Create invitation
                </Button>
              </DialogFooter>
            </form>
          </DialogContent>
        </Dialog>
      </div>

      <Alert variant="info">
        For independent beta testing, choose <strong>Member / beta tester</strong>. They can
        create their own projects with full Owner access without gaining access to anyone
        else&apos;s project.
      </Alert>

      {invitations === null ? (
        <Skeleton className="h-32" />
      ) : invitations.length === 0 ? (
        <EmptyState
          icon={Mail}
          title="No organization invitations"
          description="Create an invitation for each tester and share its one-time link privately."
        />
      ) : (
        <div className="overflow-x-auto rounded-lg border border-border bg-card">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Email</TableHead>
                <TableHead>Access</TableHead>
                <TableHead>Invited by</TableHead>
                <TableHead>Expires</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="w-20" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {invitations.map((invitation) => {
                const status = invitationStatus(invitation);
                return (
                  <TableRow key={invitation.id}>
                    <TableCell className="font-medium">{invitation.email}</TableCell>
                    <TableCell>
                      <Badge variant="secondary">{organizationRoleLabel(invitation.role)}</Badge>
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      {invitation.invitedBy.name}
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      {formatDate(invitation.expiresAt)}
                    </TableCell>
                    <TableCell>
                      <Badge variant={status.variant}>{status.label}</Badge>
                    </TableCell>
                    <TableCell>
                      {status.pending && (
                        <Button variant="ghost" size="sm" onClick={() => setRevokeTarget(invitation)}>
                          Revoke
                        </Button>
                      )}
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </div>
      )}

      <Dialog open={created !== null} onOpenChange={(open) => !open && setCreated(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Organization invitation link</DialogTitle>
            {created && (
              <DialogDescription>
                For {created.email} · {organizationRoleLabel(created.role)} · expires{" "}
                {formatDate(created.expiresAt)}
              </DialogDescription>
            )}
          </DialogHeader>
          <Alert variant="warning">
            This link is shown only once and cannot be retrieved again. Copy it now and share it
            privately with the invitee.
          </Alert>
          {created && (
            <div className="flex items-start gap-2">
              <code className="min-w-0 flex-1 select-all break-all rounded-md border border-border bg-muted px-3 py-2 font-mono text-xs leading-relaxed">
                /organization-invitations/{encodeURIComponent(created.token)}
              </code>
              <Button variant="outline" size="sm" onClick={copyInvitationLink}>
                <Copy /> Copy
              </Button>
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setCreated(null)}>
              Done
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={revokeTarget !== null}
        onOpenChange={(open) => !open && setRevokeTarget(null)}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Revoke invitation?</DialogTitle>
            <DialogDescription>
              {revokeTarget?.email} will no longer be able to register or join using this link.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setRevokeTarget(null)} disabled={revoking}>
              Cancel
            </Button>
            <Button variant="destructive" onClick={revokeInvitation} disabled={revoking}>
              {revoking && <Spinner />} Revoke
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  );
}
