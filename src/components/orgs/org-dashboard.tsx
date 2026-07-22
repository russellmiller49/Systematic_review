"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { FolderKanban } from "lucide-react";
import { toast } from "sonner";
import { api } from "@/lib/api";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { EmptyState, Skeleton } from "@/components/ui/misc";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { NewProjectDialog } from "@/components/projects/new-project-dialog";
import { LibrarySettingsSection } from "@/components/orgs/library-settings-section";
import {
  OrganizationInvitationsSection,
  organizationRoleLabel,
} from "@/components/orgs/organization-invitations-section";

interface OrgDetail {
  id: string;
  name: string;
  slug: string;
  myRole: string;
}

interface ProjectRow {
  id: string;
  title: string;
  reviewType: string;
  status: string;
  _count?: { citations: number; members: number };
}

interface MemberRow {
  id: string;
  role: string;
  status: string;
  user: { id: string; name: string; email: string };
}

const REVIEW_TYPE_LABELS: Record<string, string> = {
  SYSTEMATIC_REVIEW: "Systematic review",
  SYSTEMATIC_REVIEW_META_ANALYSIS: "SR + meta-analysis",
  DIAGNOSTIC_TEST_ACCURACY: "Diagnostic test accuracy",
  SCOPING_REVIEW: "Scoping review",
  RAPID_REVIEW: "Rapid review",
  LIVING_SYSTEMATIC_REVIEW: "Living systematic review",
  GUIDELINE_EVIDENCE_REVIEW: "Guideline evidence review",
};

export function OrgDashboard({ orgId }: { orgId: string }) {
  const [org, setOrg] = useState<OrgDetail | null>(null);
  const [projects, setProjects] = useState<ProjectRow[] | null>(null);
  const [members, setMembers] = useState<MemberRow[] | null>(null);

  const load = useCallback(() => {
    api<OrgDetail>(`/api/orgs/${orgId}`)
      .then(setOrg)
      .catch(() => toast.error("Failed to load organization"));
    api<ProjectRow[]>(`/api/orgs/${orgId}/projects`)
      .then(setProjects)
      .catch(() => setProjects([]));
    api<MemberRow[]>(`/api/orgs/${orgId}/members`)
      .then(setMembers)
      .catch(() => setMembers([]));
  }, [orgId]);

  useEffect(load, [load]);

  const canManage = org?.myRole === "OWNER" || org?.myRole === "ADMIN";

  return (
    <div className="space-y-8">
      <div className="flex items-center justify-between">
        <div>
          {org ? (
            <h1 className="text-2xl font-semibold tracking-tight">{org.name}</h1>
          ) : (
            <Skeleton className="h-8 w-56" />
          )}
          <p className="text-sm text-muted-foreground">
            Projects and team for this workspace. Every member can create and own projects.
          </p>
        </div>
        <NewProjectDialog orgId={orgId} onCreated={load} />
      </div>

      <section className="space-y-3">
        <h2 className="text-lg font-medium">Projects</h2>
        {projects === null ? (
          <Skeleton className="h-40" />
        ) : projects.length === 0 ? (
          <EmptyState
            icon={FolderKanban}
            title="No projects yet"
            description="Create a project to define a protocol, import citations, and start screening."
          />
        ) : (
          <div className="grid gap-4 sm:grid-cols-2">
            {projects.map((p) => (
              <Link key={p.id} href={`/projects/${p.id}`}>
                <Card className="h-full transition-shadow hover:shadow-md">
                  <CardHeader>
                    <div className="flex items-start justify-between gap-2">
                      <CardTitle className="text-base leading-snug">{p.title}</CardTitle>
                      <Badge variant="muted">{p.status.toLowerCase()}</Badge>
                    </div>
                    <CardDescription>
                      {REVIEW_TYPE_LABELS[p.reviewType] ?? p.reviewType}
                    </CardDescription>
                  </CardHeader>
                  {p._count && (
                    <CardContent className="text-sm text-muted-foreground">
                      {p._count.citations} citations · {p._count.members} members
                    </CardContent>
                  )}
                </Card>
              </Link>
            ))}
          </div>
        )}
      </section>

      {canManage && <OrganizationInvitationsSection orgId={orgId} />}

      {org && <LibrarySettingsSection orgId={orgId} canManage={canManage} />}

      <section className="space-y-3">
        <h2 className="text-lg font-medium">Members</h2>
        {members === null ? (
          <Skeleton className="h-32" />
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead>
                <TableHead>Email</TableHead>
                <TableHead>Role</TableHead>
                <TableHead>Status</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {members.map((m) => (
                <TableRow key={m.id}>
                  <TableCell className="font-medium">{m.user.name}</TableCell>
                  <TableCell className="text-muted-foreground">{m.user.email}</TableCell>
                  <TableCell>
                    <Badge variant="secondary">{organizationRoleLabel(m.role)}</Badge>
                  </TableCell>
                  <TableCell>
                    <Badge variant={m.status === "ACTIVE" ? "include" : "muted"}>
                      {m.status.toLowerCase()}
                    </Badge>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </section>
    </div>
  );
}
