"use client";

import { useCallback, useEffect, useState } from "react";
import { UserCog, UserMinus, UserPlus, Users } from "lucide-react";
import { toast } from "sonner";
import { api, apiDelete, apiPatch, apiPost, ApiError } from "@/lib/api";
import { Badge } from "@/components/ui/badge";
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

interface MemberRow {
  id: string;
  userId: string;
  roles: string[];
  status: string;
  user: { id: string; name: string; email: string };
}

export function MembersSection({
  projectId,
  canManage,
}: {
  projectId: string;
  canManage: boolean;
}) {
  const [members, setMembers] = useState<MemberRow[] | null>(null);

  const [addOpen, setAddOpen] = useState(false);
  const [addEmail, setAddEmail] = useState("");
  const [addRoles, setAddRoles] = useState<string[]>(["REVIEWER"]);
  const [adding, setAdding] = useState(false);

  const [editTarget, setEditTarget] = useState<MemberRow | null>(null);
  const [editRoles, setEditRoles] = useState<string[]>([]);
  const [savingRoles, setSavingRoles] = useState(false);

  const [removeTarget, setRemoveTarget] = useState<MemberRow | null>(null);
  const [removing, setRemoving] = useState(false);

  const load = useCallback(() => {
    api<MemberRow[]>(`/api/projects/${projectId}/members`)
      .then(setMembers)
      .catch(() => {
        toast.error("Failed to load members");
        setMembers([]);
      });
  }, [projectId]);

  useEffect(load, [load]);

  async function addMember(e: React.FormEvent) {
    e.preventDefault();
    setAdding(true);
    try {
      await apiPost(`/api/projects/${projectId}/members`, {
        email: addEmail.trim(),
        roles: addRoles,
      });
      toast.success("Member added");
      setAddOpen(false);
      setAddEmail("");
      setAddRoles(["REVIEWER"]);
      load();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Failed to add member");
    } finally {
      setAdding(false);
    }
  }

  async function saveRoles(e: React.FormEvent) {
    e.preventDefault();
    if (!editTarget) return;
    setSavingRoles(true);
    try {
      await apiPatch(`/api/projects/${projectId}/members/${editTarget.userId}`, {
        roles: editRoles,
      });
      toast.success("Roles updated");
      setEditTarget(null);
      load();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Failed to update roles");
    } finally {
      setSavingRoles(false);
    }
  }

  async function removeMember() {
    if (!removeTarget) return;
    setRemoving(true);
    try {
      await apiDelete(`/api/projects/${projectId}/members/${removeTarget.userId}`);
      toast.success("Member removed");
      setRemoveTarget(null);
      load();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Failed to remove member");
    } finally {
      setRemoving(false);
    }
  }

  return (
    <section className="space-y-3">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-medium">Members</h2>
        {canManage && (
          <Dialog open={addOpen} onOpenChange={setAddOpen}>
            <DialogTrigger asChild>
              <Button variant="outline" size="sm">
                <UserPlus /> Add member
              </Button>
            </DialogTrigger>
            <DialogContent>
              <DialogHeader>
                <DialogTitle>Add member</DialogTitle>
                <DialogDescription>
                  The person must already have an account and be a member of this
                  project&apos;s organization — otherwise send them an invitation below.
                </DialogDescription>
              </DialogHeader>
              <form onSubmit={addMember} className="space-y-4">
                <div className="space-y-1.5">
                  <Label htmlFor="am-email">Email</Label>
                  <Input
                    id="am-email"
                    type="email"
                    required
                    value={addEmail}
                    onChange={(e) => setAddEmail(e.target.value)}
                  />
                </div>
                <div className="space-y-1.5">
                  <Label>Roles</Label>
                  <RolesChecklist value={addRoles} onChange={setAddRoles} />
                </div>
                <DialogFooter>
                  <Button type="submit" disabled={adding || addRoles.length === 0}>
                    {adding && <Spinner />} Add member
                  </Button>
                </DialogFooter>
              </form>
            </DialogContent>
          </Dialog>
        )}
      </div>

      {canManage && (
        <Alert variant="info">
          The project creator starts as Owner. Owners and Admins can manage members, roles, and
          screening assignments; you may add multiple Admins. To transfer ownership, first grant
          Owner to another member, then change the prior owner&apos;s role. Reviewers can work only
          on citations assigned to them.
        </Alert>
      )}

      {members === null ? (
        <Skeleton className="h-40" />
      ) : members.length === 0 ? (
        <EmptyState
          icon={Users}
          title="No members"
          description="Add teammates so they can screen, extract, and adjudicate."
        />
      ) : (
        <div className="rounded-lg border border-border bg-card">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead>
                <TableHead>Email</TableHead>
                <TableHead>Roles</TableHead>
                <TableHead>Status</TableHead>
                {canManage && <TableHead className="w-24" />}
              </TableRow>
            </TableHeader>
            <TableBody>
              {members.map((m) => (
                <TableRow key={m.id}>
                  <TableCell className="font-medium">{m.user.name}</TableCell>
                  <TableCell className="text-muted-foreground">{m.user.email}</TableCell>
                  <TableCell>
                    <div className="flex flex-wrap gap-1">
                      {m.roles.map((role) => (
                        <Badge key={role} variant="secondary">
                          {roleLabel(role)}
                        </Badge>
                      ))}
                    </div>
                  </TableCell>
                  <TableCell>
                    <Badge variant={m.status === "ACTIVE" ? "include" : "muted"}>
                      {m.status.toLowerCase()}
                    </Badge>
                  </TableCell>
                  {canManage && (
                    <TableCell>
                      {m.status === "ACTIVE" && (
                        <div className="flex justify-end gap-1">
                          <Button
                            variant="ghost"
                            size="icon"
                            title="Change roles"
                            onClick={() => {
                              setEditTarget(m);
                              setEditRoles(m.roles);
                            }}
                          >
                            <UserCog />
                          </Button>
                          <Button
                            variant="ghost"
                            size="icon"
                            title="Remove member"
                            onClick={() => setRemoveTarget(m)}
                          >
                            <UserMinus />
                          </Button>
                        </div>
                      )}
                    </TableCell>
                  )}
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}

      <Dialog open={editTarget !== null} onOpenChange={(open) => !open && setEditTarget(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Change roles</DialogTitle>
            {editTarget && (
              <DialogDescription>
                {editTarget.user.name} · {editTarget.user.email}
              </DialogDescription>
            )}
          </DialogHeader>
          <form onSubmit={saveRoles} className="space-y-4">
            <RolesChecklist value={editRoles} onChange={setEditRoles} />
            <DialogFooter>
              <Button type="submit" disabled={savingRoles || editRoles.length === 0}>
                {savingRoles && <Spinner />} Save roles
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <Dialog
        open={removeTarget !== null}
        onOpenChange={(open) => !open && setRemoveTarget(null)}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Remove {removeTarget?.user.name}?</DialogTitle>
            <DialogDescription>
              They lose access to this project. Their past decisions and assessments remain
              attributed to them.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setRemoveTarget(null)}>
              Cancel
            </Button>
            <Button variant="destructive" onClick={removeMember} disabled={removing}>
              {removing && <Spinner />} Remove
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  );
}
