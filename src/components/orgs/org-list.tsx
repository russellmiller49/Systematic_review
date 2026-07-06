"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { Building2, FolderKanban, Plus, Users } from "lucide-react";
import { toast } from "sonner";
import { api, apiPost, ApiError } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { EmptyState, Skeleton, Spinner } from "@/components/ui/misc";
import { Badge } from "@/components/ui/badge";

interface Org {
  id: string;
  name: string;
  slug: string;
  role: string;
  _count: { projects: number; members: number };
}

export function OrgList() {
  const [orgs, setOrgs] = useState<Org[] | null>(null);
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    api<Org[]>("/api/orgs")
      .then(setOrgs)
      .catch(() => toast.error("Failed to load organizations"));
  }, []);

  useEffect(load, [load]);

  async function createOrg(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      await apiPost("/api/orgs", { name });
      toast.success("Organization created");
      setOpen(false);
      setName("");
      load();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Failed to create organization");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Organizations</h1>
          <p className="text-sm text-muted-foreground">
            Workspaces for your review teams and their projects.
          </p>
        </div>
        <Dialog open={open} onOpenChange={setOpen}>
          <DialogTrigger asChild>
            <Button>
              <Plus /> New organization
            </Button>
          </DialogTrigger>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Create organization</DialogTitle>
            </DialogHeader>
            <form onSubmit={createOrg} className="space-y-4">
              <div className="space-y-1.5">
                <Label htmlFor="org-name">Name</Label>
                <Input
                  id="org-name"
                  required
                  minLength={2}
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="e.g. Interventional Pulmonology Research Group"
                />
              </div>
              <DialogFooter>
                <Button type="submit" disabled={busy}>
                  {busy && <Spinner />} Create
                </Button>
              </DialogFooter>
            </form>
          </DialogContent>
        </Dialog>
      </div>

      {orgs === null ? (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} className="h-32" />
          ))}
        </div>
      ) : orgs.length === 0 ? (
        <EmptyState
          icon={Building2}
          title="No organizations yet"
          description="Create an organization to start your first systematic review project."
        />
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {orgs.map((org) => (
            <Link key={org.id} href={`/orgs/${org.id}`}>
              <Card className="h-full transition-shadow hover:shadow-md">
                <CardHeader>
                  <div className="flex items-start justify-between">
                    <CardTitle className="text-base">{org.name}</CardTitle>
                    <Badge variant="secondary">{org.role.toLowerCase()}</Badge>
                  </div>
                  <CardDescription>/{org.slug}</CardDescription>
                </CardHeader>
                <CardContent className="flex gap-4 text-sm text-muted-foreground">
                  <span className="flex items-center gap-1">
                    <FolderKanban className="h-4 w-4" /> {org._count.projects} projects
                  </span>
                  <span className="flex items-center gap-1">
                    <Users className="h-4 w-4" /> {org._count.members} members
                  </span>
                </CardContent>
              </Card>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
