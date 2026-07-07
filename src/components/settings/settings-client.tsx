"use client";

import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { api, ApiError } from "@/lib/api";
import { PageHeader } from "@/components/layout/page-header";
import { Alert } from "@/components/ui/misc";
import type { ProjectDetail } from "./types";
import { ProjectSettingsSection } from "./project-settings";
import { MembersSection } from "./members-section";
import { InvitationsSection } from "./invitations-section";
import { ExclusionReasonsSection } from "./exclusion-reasons-section";
import { ExportsSection } from "./exports-section";
import { DangerZone } from "./danger-zone";

export function SettingsClient({ projectId }: { projectId: string }) {
  const [project, setProject] = useState<ProjectDetail | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  const load = useCallback(() => {
    api<ProjectDetail>(`/api/projects/${projectId}`)
      .then((p) => {
        setProject(p);
        setLoadError(null);
      })
      .catch((err) => {
        setLoadError(err instanceof ApiError ? err.message : "Failed to load project");
        toast.error("Failed to load project settings");
      });
  }, [projectId]);

  useEffect(load, [load]);

  const roles = project?.myRoles ?? [];
  const isAdmin = roles.includes("OWNER") || roles.includes("ADMIN");
  const canEditProtocol = isAdmin || roles.includes("LIBRARIAN");

  return (
    <div className="mx-auto max-w-4xl">
      <PageHeader
        title="Settings"
        description="Project configuration, team, and data management."
      />
      {loadError ? (
        <Alert variant="error">{loadError}</Alert>
      ) : (
        <div className="space-y-10">
          <ProjectSettingsSection
            projectId={projectId}
            project={project}
            canEdit={isAdmin}
            onSaved={load}
          />
          <MembersSection projectId={projectId} canManage={isAdmin} />
          <InvitationsSection projectId={projectId} />
          <ExclusionReasonsSection projectId={projectId} canEdit={canEditProtocol} />
          <ExportsSection projectId={projectId} />
          {project && isAdmin && (
            <DangerZone projectId={projectId} project={project} onChanged={load} />
          )}
        </div>
      )}
    </div>
  );
}
