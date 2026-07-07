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
import { Alert, EmptyState, Skeleton, Spinner } from "@/components/ui/misc";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { RolesChecklist, roleLabel } from "./roles";

// List responses never include the token (R11) — it appears only in the create response.
interface InvitationRow {
  id: string;
  email: string;
  roles: string[];
  expiresAt: string;
  acceptedAt: string | null;
  revokedAt: string | null;
  createdAt: string;
  invitedBy: { id: string; name: string; email: string };
}

interface CreatedInvitation {
  id: string;
  email: string;
  roles: string[];
  token: string;
  expiresAt: string;
}

function invitationStatus(inv: InvitationRow): {
  label: string;
  variant: BadgeProps["variant"];
  pending: boolean;
} {
  if (inv.revokedAt) return { label: "revoked", variant: "exclude", pending: false };
  if (inv.acceptedAt) return { label: "accepted", variant: "include", pending: false };
  if (new Date(inv.expiresAt).getTime() < Date.now()) {
    return { label: "expired", variant: "muted", pending: false };
  }
  return { label: "pending", variant: "maybe", pending: true };
}

export function InvitationsSection({ projectId }: { projectId: string }) {
  const [invitations, setInvitations] = useState<InvitationRow[] | null>(null);
  const [hidden, setHidden] = useState(false);

  const [createOpen, setCreateOpen] = useState(false);
  const [email, setEmail] = useState("");
  const [roles, setRoles] = useState<string[]>(["REVIEWER"]);
  const [creating, setCreating] = useState(false);

  const [created, setCreated] = useState<CreatedInvitation | null>(null);
  const [revokeTarget, setRevokeTarget] = useState<InvitationRow | null>(null);
  const [revoking, setRevoking] = useState(false);

  const load = useCallback(() => {
    api<InvitationRow[]>(`/api/projects/${projectId}/invitations`)
      .then(setInvitations)
      .catch((err) => {
        if (err instanceof ApiError && err.status === 403) {
          setHidden(true); // non-admins can't list invitations — hide the section
        } else {
          toast.error("Failed to load invitations");
          setInvitations([]);
        }
      });
  }, [projectId]);

  useEffect(load, [load]);

  async function createInvitation(e: React.FormEvent) {
    e.preventDefault();
    setCreating(true);
    try {
      const invitation = await apiPost<CreatedInvitation>(
        `/api/projects/${projectId}/invitations`,
        { email: email.trim(), roles },
      );
      toast.success("Invitation created");
      setCreateOpen(false);
      setEmail("");
      setRoles(["REVIEWER"]);
      setCreated(invitation);
      load();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Failed to create invitation");
    } finally {
      setCreating(false);
    }
  }

  async function copyToken() {
    if (!created) return;
    try {
      await navigator.clipboard.writeText(created.token);
      toast.success("Token copied to clipboard");
    } catch {
      toast.error("Could not copy — select the token manually");
    }
  }

  async function revokeInvitation() {
    if (!revokeTarget) return;
    setRevoking(true);
    try {
      await apiDelete(`/api/projects/${projectId}/invitations/${revokeTarget.id}`);
      toast.success("Invitation revoked");
      setRevokeTarget(null);
      load();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Failed to revoke invitation");
    } finally {
      setRevoking(false);
    }
  }

  if (hidden) return null;

  return (
    <section className="space-y-3">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-medium">Invitations</h2>
        <Dialog open={createOpen} onOpenChange={setCreateOpen}>
          <DialogTrigger asChild>
            <Button variant="outline" size="sm">
              <MailPlus /> Invite
            </Button>
          </DialogTrigger>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Invite to project</DialogTitle>
              <DialogDescription>
                Creates a one-time token to share with the invitee. They redeem it from their
                account to join with the roles you pick.
              </DialogDescription>
            </DialogHeader>
            <form onSubmit={createInvitation} className="space-y-4">
              <div className="space-y-1.5">
                <Label htmlFor="inv-email">Email</Label>
                <Input
                  id="inv-email"
                  type="email"
                  required
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                />
              </div>
              <div className="space-y-1.5">
                <Label>Roles</Label>
                <RolesChecklist value={roles} onChange={setRoles} />
              </div>
              <DialogFooter>
                <Button type="submit" disabled={creating || roles.length === 0}>
                  {creating && <Spinner />} Create invitation
                </Button>
              </DialogFooter>
            </form>
          </DialogContent>
        </Dialog>
      </div>

      {invitations === null ? (
        <Skeleton className="h-32" />
      ) : invitations.length === 0 ? (
        <EmptyState
          icon={Mail}
          title="No invitations"
          description="Invite collaborators by email — they join by redeeming a one-time token."
        />
      ) : (
        <div className="rounded-lg border border-border bg-card">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Email</TableHead>
                <TableHead>Roles</TableHead>
                <TableHead>Invited by</TableHead>
                <TableHead>Expires</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="w-20" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {invitations.map((inv) => {
                const status = invitationStatus(inv);
                return (
                  <TableRow key={inv.id}>
                    <TableCell className="font-medium">{inv.email}</TableCell>
                    <TableCell>
                      <div className="flex flex-wrap gap-1">
                        {inv.roles.map((role) => (
                          <Badge key={role} variant="secondary">
                            {roleLabel(role)}
                          </Badge>
                        ))}
                      </div>
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      {inv.invitedBy.name}
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      {formatDate(inv.expiresAt)}
                    </TableCell>
                    <TableCell>
                      <Badge variant={status.variant}>{status.label}</Badge>
                    </TableCell>
                    <TableCell>
                      {status.pending && (
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => setRevokeTarget(inv)}
                        >
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
            <DialogTitle>Invitation token</DialogTitle>
            {created && (
              <DialogDescription>
                For {created.email} · expires {formatDate(created.expiresAt)}
              </DialogDescription>
            )}
          </DialogHeader>
          <Alert variant="warning">
            This token is shown only once and cannot be retrieved again. Copy it now and share
            it securely with the invitee.
          </Alert>
          {created && (
            <div className="flex items-start gap-2">
              <code className="min-w-0 flex-1 select-all break-all rounded-md border border-border bg-muted px-3 py-2 font-mono text-xs leading-relaxed">
                {created.token}
              </code>
              <Button variant="outline" size="sm" onClick={copyToken}>
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
              The token issued to {revokeTarget?.email} will stop working immediately.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setRevokeTarget(null)}>
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
