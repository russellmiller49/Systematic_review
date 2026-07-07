"use client";

// /projects/[projectId]/protocol — protocol builder.
// Loads GET /protocol once and shares it with the tabs; child tabs call onChanged (reload)
// after mutations. Versions and exclusion-reasons tabs fetch their own data on mount.

import { useCallback, useEffect, useState } from "react";
import { Lock } from "lucide-react";
import { toast } from "sonner";
import { api, apiPost } from "@/lib/api";
import { PageHeader } from "@/components/layout/page-header";
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
import { Alert, Skeleton, Spinner } from "@/components/ui/misc";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { AmendmentDialog, toastApiError, useAmendmentGate } from "./amendment-gate";
import { CriteriaTab } from "./criteria-tab";
import { ExclusionReasonsTab } from "./exclusion-reasons-tab";
import { OutcomesTab } from "./outcomes-tab";
import { OverviewTab } from "./overview-tab";
import { PicoTab } from "./pico-tab";
import type { ProtocolDetail, VersionRow } from "./types";
import { VersionsTab } from "./versions-tab";

export function ProtocolPage({ projectId }: { projectId: string }) {
  const [protocol, setProtocol] = useState<ProtocolDetail | null>(null);
  const [publishOpen, setPublishOpen] = useState(false);
  const [publishing, setPublishing] = useState(false);
  const gate = useAmendmentGate();

  const load = useCallback(() => {
    api<ProtocolDetail>(`/api/projects/${projectId}/protocol`)
      .then(setProtocol)
      .catch((err) => toastApiError(err, "Failed to load protocol"));
  }, [projectId]);

  useEffect(load, [load]);

  async function publish() {
    setPublishing(true);
    try {
      const version = await apiPost<VersionRow>(
        `/api/projects/${projectId}/protocol/publish`,
      );
      toast.success(`Protocol published as version ${version.versionNumber}`);
      setPublishOpen(false);
      load();
    } catch (err) {
      toastApiError(err, "Failed to publish protocol");
    } finally {
      setPublishing(false);
    }
  }

  const published = protocol !== null && protocol.latestVersionNumber > 0;
  const nextVersion = (protocol?.latestVersionNumber ?? 0) + 1;

  return (
    <div className="mx-auto w-full max-w-5xl">
      <PageHeader
        title="Protocol"
        description="The preregistered plan: question, eligibility, outcomes and analysis."
        actions={
          protocol !== null && (
            <>
              <Badge variant={published ? "include" : "maybe"}>
                {published ? `Version ${protocol.latestVersionNumber}` : "Draft"}
              </Badge>
              <Dialog open={publishOpen} onOpenChange={setPublishOpen}>
                <DialogTrigger asChild>
                  <Button size="sm">
                    <Lock /> {published ? "Publish new version" : "Publish protocol"}
                  </Button>
                </DialogTrigger>
                <DialogContent>
                  <DialogHeader>
                    <DialogTitle>Publish version {nextVersion}?</DialogTitle>
                    <DialogDescription>
                      Publishing freezes the entire protocol — core fields, PICO, criteria,
                      outcomes, screening stage settings and exclusion reasons — as an immutable
                      version {nextVersion} snapshot.
                    </DialogDescription>
                  </DialogHeader>
                  <p className="text-sm text-muted-foreground">
                    Published versions can never be edited or deleted. The working protocol stays
                    editable, but once screening has begun every change must carry an amendment
                    note, and each amendment freezes the next version automatically.
                  </p>
                  <DialogFooter>
                    <Button
                      variant="outline"
                      onClick={() => setPublishOpen(false)}
                      disabled={publishing}
                    >
                      Cancel
                    </Button>
                    <Button onClick={() => void publish()} disabled={publishing}>
                      {publishing && <Spinner />} Publish version {nextVersion}
                    </Button>
                  </DialogFooter>
                </DialogContent>
              </Dialog>
            </>
          )
        }
      />

      {protocol !== null && (
        <div className="mb-6">
          {published ? (
            <Alert variant="success">
              <span className="font-medium">
                Published — version {protocol.latestVersionNumber} is the current frozen
                snapshot.
              </span>{" "}
              The protocol remains editable; once screening has begun, each change requires an
              amendment note and freezes a new version automatically.
            </Alert>
          ) : (
            <Alert variant="info">
              <span className="font-medium">Draft protocol — nothing frozen yet.</span> Publish
              to record version 1 as the preregistered protocol. Once screening begins, any
              further change must be documented as an amendment.
            </Alert>
          )}
        </div>
      )}

      {protocol === null ? (
        <div className="space-y-4">
          <Skeleton className="h-9 w-full max-w-xl" />
          <Skeleton className="h-64" />
        </div>
      ) : (
        <Tabs defaultValue="overview">
          <TabsList className="h-auto flex-wrap">
            <TabsTrigger value="overview">Overview</TabsTrigger>
            <TabsTrigger value="criteria">Criteria</TabsTrigger>
            <TabsTrigger value="outcomes">Outcomes</TabsTrigger>
            <TabsTrigger value="pico">PICO</TabsTrigger>
            <TabsTrigger value="versions">Versions &amp; amendments</TabsTrigger>
            <TabsTrigger value="exclusion-reasons">Exclusion reasons</TabsTrigger>
          </TabsList>
          <TabsContent value="overview">
            <OverviewTab
              projectId={projectId}
              protocol={protocol}
              gate={gate}
              onChanged={load}
            />
          </TabsContent>
          <TabsContent value="criteria">
            <CriteriaTab
              projectId={projectId}
              protocol={protocol}
              gate={gate}
              onChanged={load}
            />
          </TabsContent>
          <TabsContent value="outcomes">
            <OutcomesTab
              projectId={projectId}
              protocol={protocol}
              gate={gate}
              onChanged={load}
            />
          </TabsContent>
          <TabsContent value="pico">
            <PicoTab projectId={projectId} protocol={protocol} gate={gate} onChanged={load} />
          </TabsContent>
          <TabsContent value="versions">
            <VersionsTab
              projectId={projectId}
              latestVersionNumber={protocol.latestVersionNumber}
            />
          </TabsContent>
          <TabsContent value="exclusion-reasons">
            <ExclusionReasonsTab projectId={projectId} />
          </TabsContent>
        </Tabs>
      )}

      <AmendmentDialog gate={gate} />
    </div>
  );
}
