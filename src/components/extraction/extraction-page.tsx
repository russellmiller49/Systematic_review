"use client";

// Extraction hub: Templates (builder + versioning) | Extract (studies + form workspace) |
// Conflicts (adjudication). Tabs are force-mounted so workspace state survives tab switches.

import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { api } from "@/lib/api";
import { PageHeader } from "@/components/layout/page-header";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ConflictsTab } from "./conflicts-tab";
import { ExtractTab } from "./extract-tab";
import { TemplatesTab } from "./templates-tab";
import { hasCap, type Template } from "./types";

interface MeResponse {
  user: { id: string };
}

interface ProjectResponse {
  myRoles: string[];
}

export function ExtractionClient({ projectId }: { projectId: string }) {
  const [meId, setMeId] = useState<string | null>(null);
  const [roles, setRoles] = useState<string[] | null>(null);
  const [templates, setTemplates] = useState<Template[] | null>(null);

  const loadTemplates = useCallback(() => {
    api<Template[]>(`/api/projects/${projectId}/extraction/templates`)
      .then(setTemplates)
      .catch(() => {
        setTemplates([]);
        toast.error("Failed to load extraction templates");
      });
  }, [projectId]);

  useEffect(() => {
    api<MeResponse>("/api/me")
      .then((d) => setMeId(d.user.id))
      .catch(() => setMeId(null));
    api<ProjectResponse>(`/api/projects/${projectId}`)
      .then((p) => setRoles(p.myRoles))
      .catch(() => setRoles([]));
    loadTemplates();
  }, [projectId, loadTemplates]);

  return (
    <div>
      <PageHeader
        title="Data extraction"
        description="Design extraction templates, collect study data in duplicate, and adjudicate disagreements."
      />
      <Tabs defaultValue="templates">
        <TabsList>
          <TabsTrigger value="templates">Templates</TabsTrigger>
          <TabsTrigger value="extract">Extract</TabsTrigger>
          <TabsTrigger value="conflicts">Conflicts</TabsTrigger>
        </TabsList>
        <TabsContent value="templates" forceMount className="data-[state=inactive]:hidden">
          <TemplatesTab
            projectId={projectId}
            templates={templates}
            onChanged={loadTemplates}
            canManage={hasCap(roles, "extraction.templates")}
          />
        </TabsContent>
        <TabsContent value="extract" forceMount className="data-[state=inactive]:hidden">
          <ExtractTab projectId={projectId} templates={templates} meId={meId} roles={roles} />
        </TabsContent>
        <TabsContent value="conflicts" forceMount className="data-[state=inactive]:hidden">
          <ConflictsTab projectId={projectId} roles={roles} />
        </TabsContent>
      </Tabs>
    </div>
  );
}
