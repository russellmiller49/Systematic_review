"use client";

import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { api, ApiError } from "@/lib/api";
import { PageHeader } from "@/components/layout/page-header";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { AssessTab } from "./assess-tab";
import { SummaryTab } from "./summary-tab";
import { ToolsTab } from "./tools-tab";
import {
  hasCap,
  type MemberRow,
  type RobAssessment,
  type RobAssignment,
  type RobConflict,
  type RobTool,
  type StudyRow,
} from "./types";

interface MePayload {
  user: { id: string };
}

interface ProjectPayload {
  myRoles: string[];
}

export function RobPage({ projectId }: { projectId: string }) {
  const [meId, setMeId] = useState<string | null>(null);
  const [roles, setRoles] = useState<string[] | null>(null);
  const [tools, setTools] = useState<RobTool[] | null>(null);
  const [builtins, setBuiltins] = useState<RobTool[] | null>(null);
  const [studies, setStudies] = useState<StudyRow[] | null>(null);
  const [members, setMembers] = useState<MemberRow[] | null>(null);
  const [assessments, setAssessments] = useState<RobAssessment[] | null>(null);
  const [myAssignments, setMyAssignments] = useState<RobAssignment[] | null>(null);
  const [conflicts, setConflicts] = useState<RobConflict[] | null>(null);
  // The conflict list requires rob.adjudicate — a 403 hides the panel gracefully.
  const [conflictsVisible, setConflictsVisible] = useState(true);

  const loadTools = useCallback(() => {
    api<RobTool[]>(`/api/projects/${projectId}/rob/tools`)
      .then(setTools)
      .catch(() => {
        setTools([]);
        toast.error("Failed to load risk-of-bias tools");
      });
    api<RobTool[]>(`/api/rob/tools`)
      .then(setBuiltins)
      .catch(() => setBuiltins([]));
  }, [projectId]);

  const loadAssessments = useCallback(async (): Promise<RobAssessment[]> => {
    try {
      const rows = await api<RobAssessment[]>(`/api/projects/${projectId}/rob/assessments`);
      setAssessments(rows);
      return rows;
    } catch {
      setAssessments([]);
      return [];
    }
  }, [projectId]);

  const loadAssignments = useCallback(() => {
    api<RobAssignment[]>(`/api/projects/${projectId}/rob/assignments?mine=true`)
      .then(setMyAssignments)
      .catch(() => setMyAssignments([]));
  }, [projectId]);

  const loadConflicts = useCallback(() => {
    api<RobConflict[]>(`/api/projects/${projectId}/rob/conflicts`)
      .then((rows) => {
        setConflicts(rows);
        setConflictsVisible(true);
      })
      .catch((err: unknown) => {
        setConflicts([]);
        if (err instanceof ApiError && err.status === 403) setConflictsVisible(false);
      });
  }, [projectId]);

  const load = useCallback(() => {
    api<MePayload>(`/api/me`)
      .then((me) => setMeId(me.user.id))
      .catch(() => toast.error("Failed to load your session"));
    api<ProjectPayload>(`/api/projects/${projectId}`)
      .then((p) => setRoles(p.myRoles))
      .catch(() => setRoles([]));
    api<StudyRow[]>(`/api/projects/${projectId}/studies`)
      .then(setStudies)
      .catch(() => setStudies([]));
    api<MemberRow[]>(`/api/projects/${projectId}/members`)
      .then(setMembers)
      .catch(() => setMembers([]));
    loadTools();
    void loadAssessments();
    loadAssignments();
    loadConflicts();
  }, [projectId, loadTools, loadAssessments, loadAssignments, loadConflicts]);

  useEffect(load, [load]);

  const refreshAssessData = useCallback(() => {
    void loadAssessments();
    loadAssignments();
    loadConflicts();
  }, [loadAssessments, loadAssignments, loadConflicts]);

  const canManageTools = hasCap(roles, "rob.tools");
  const canAssess = hasCap(roles, "rob.assess");
  const canEditProject = hasCap(roles, "project.edit");

  const openConflictCount =
    conflictsVisible && conflicts ? conflicts.filter((c) => c.status === "OPEN").length : 0;

  return (
    <div>
      <PageHeader
        title="Risk of bias"
        description="Build assessment tools, assess studies domain by domain, and review the traffic-light summary."
      />
      <Tabs defaultValue="tools">
        <TabsList>
          <TabsTrigger value="tools">Tools</TabsTrigger>
          <TabsTrigger value="assess">Assess</TabsTrigger>
          <TabsTrigger value="summary">
            Summary
            {openConflictCount > 0 && (
              <Badge variant="maybe" className="ml-1.5 px-1.5 py-0">
                {openConflictCount}
              </Badge>
            )}
          </TabsTrigger>
        </TabsList>

        <TabsContent value="tools">
          <ToolsTab
            projectId={projectId}
            tools={tools}
            builtins={builtins}
            canManage={canManageTools}
            onChanged={loadTools}
          />
        </TabsContent>

        <TabsContent value="assess">
          <AssessTab
            projectId={projectId}
            meId={meId}
            tools={tools}
            studies={studies}
            members={members}
            assessments={assessments}
            myAssignments={myAssignments}
            canAssess={canAssess}
            canEditProject={canEditProject}
            reloadAssessments={loadAssessments}
            refreshAll={refreshAssessData}
          />
        </TabsContent>

        <TabsContent value="summary">
          <SummaryTab
            projectId={projectId}
            tools={tools}
            assessments={assessments}
            conflicts={conflicts}
            conflictsVisible={conflictsVisible}
            onAdjudicated={refreshAssessData}
          />
        </TabsContent>
      </Tabs>
    </div>
  );
}
