"use client";

import { useMemo, useState } from "react";
import { ClipboardCheck, Eye, ListChecks, Play, Plus } from "lucide-react";
import { toast } from "sonner";
import { apiPost, ApiError } from "@/lib/api";
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
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import { EmptyState, Skeleton, Spinner } from "@/components/ui/misc";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { AssessmentWorkspace } from "./assessment-workspace";
import { AssignDialog } from "./assign-dialog";
import { JudgmentBadge } from "./judgment";
import {
  getScale,
  type MemberRow,
  type RobAssessment,
  type RobAssignment,
  type RobTool,
  type StudyRow,
} from "./types";

const ASSIGNMENT_VARIANT = { PENDING: "maybe", COMPLETED: "include", VOIDED: "muted" } as const;

export function AssessTab({
  projectId,
  meId,
  tools,
  studies,
  members,
  assessments,
  myAssignments,
  canAssess,
  canEditProject,
  reloadAssessments,
  refreshAll,
}: {
  projectId: string;
  meId: string | null;
  tools: RobTool[] | null;
  studies: StudyRow[] | null;
  members: MemberRow[] | null;
  assessments: RobAssessment[] | null;
  myAssignments: RobAssignment[] | null;
  canAssess: boolean;
  canEditProject: boolean;
  reloadAssessments: () => Promise<RobAssessment[]>;
  refreshAll: () => void;
}) {
  const [openId, setOpenId] = useState<string | null>(null);
  const [startingKey, setStartingKey] = useState<string | null>(null);

  const mine = useMemo(
    () => (assessments && meId ? assessments.filter((a) => a.assessorId === meId) : null),
    [assessments, meId],
  );
  // The server only returns co-assessors' work to adjudicators/admins, so a
  // non-empty "others" list means the caller is allowed to see it.
  const others = useMemo(
    () => (assessments && meId ? assessments.filter((a) => a.assessorId !== meId) : []),
    [assessments, meId],
  );
  const myAssessmentByKey = useMemo(() => {
    const map = new Map<string, RobAssessment>();
    for (const a of mine ?? []) map.set(`${a.studyId}:${a.toolId}`, a);
    return map;
  }, [mine]);

  const open = openId && assessments ? (assessments.find((a) => a.id === openId) ?? null) : null;

  async function start(studyId: string, toolId: string) {
    const key = `${studyId}:${toolId}`;
    setStartingKey(key);
    try {
      const started = await apiPost<{ id: string }>(
        `/api/projects/${projectId}/studies/${studyId}/rob-assessments`,
        { toolId },
      );
      toast.success("Assessment started");
      await reloadAssessments();
      setOpenId(started.id);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Failed to start assessment");
    } finally {
      setStartingKey(null);
    }
  }

  if (open) {
    return (
      <AssessmentWorkspace
        key={open.id}
        projectId={projectId}
        assessment={open}
        tool={tools?.find((t) => t.id === open.toolId)}
        meId={meId}
        onBack={() => {
          setOpenId(null);
          refreshAll();
        }}
        onChanged={refreshAll}
      />
    );
  }

  return (
    <div className="space-y-8">
      <div className="flex flex-wrap items-center justify-end gap-2">
        {canAssess && tools && studies && (
          <StartDialog
            tools={tools}
            studies={studies}
            busyKey={startingKey}
            onStart={(studyId, toolId) => void start(studyId, toolId)}
          />
        )}
        {canEditProject && tools && studies && members && (
          <AssignDialog
            projectId={projectId}
            tools={tools}
            studies={studies}
            members={members}
            onCreated={refreshAll}
          />
        )}
      </div>

      <section className="space-y-3">
        <h2 className="text-lg font-medium">My assignments</h2>
        {myAssignments === null || assessments === null || meId === null ? (
          <Skeleton className="h-32" />
        ) : myAssignments.length === 0 ? (
          <EmptyState
            icon={ClipboardCheck}
            title="No assignments for you"
            description="Admins assign studies to assessors from this tab. You can also start an assessment directly if you have the rights."
          />
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Study</TableHead>
                <TableHead>Tool</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="w-32 text-right">Action</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {myAssignments.map((assignment) => {
                const existing = myAssessmentByKey.get(
                  `${assignment.studyId}:${assignment.toolId}`,
                );
                const key = `${assignment.studyId}:${assignment.toolId}`;
                return (
                  <TableRow key={assignment.id}>
                    <TableCell className="font-medium">{assignment.study.label}</TableCell>
                    <TableCell className="text-muted-foreground">{assignment.tool.name}</TableCell>
                    <TableCell>
                      <Badge variant={ASSIGNMENT_VARIANT[assignment.status]}>
                        {assignment.status.toLowerCase()}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-right">
                      {existing ? (
                        <Button variant="outline" size="sm" onClick={() => setOpenId(existing.id)}>
                          {existing.status === "COMPLETED" ? <Eye /> : <Play />}
                          {existing.status === "COMPLETED" ? "View" : "Continue"}
                        </Button>
                      ) : assignment.status === "VOIDED" ? (
                        <span className="text-sm text-muted-foreground">—</span>
                      ) : canAssess ? (
                        <Button
                          size="sm"
                          disabled={startingKey !== null}
                          onClick={() => void start(assignment.studyId, assignment.toolId)}
                        >
                          {startingKey === key ? <Spinner /> : <Play />} Start
                        </Button>
                      ) : (
                        <span className="text-sm text-muted-foreground">—</span>
                      )}
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        )}
      </section>

      <section className="space-y-3">
        <h2 className="text-lg font-medium">My assessments</h2>
        {mine === null ? (
          <Skeleton className="h-32" />
        ) : mine.length === 0 ? (
          <EmptyState
            icon={ListChecks}
            title="No assessments yet"
            description="Start an assessment from an assignment above, or use New assessment to pick a study and tool."
          />
        ) : (
          <AssessmentTable
            rows={mine}
            tools={tools}
            showAssessor={false}
            onOpen={setOpenId}
          />
        )}
      </section>

      {others.length > 0 && (
        <section className="space-y-3">
          <div>
            <h2 className="text-lg font-medium">Team assessments</h2>
            <p className="text-sm text-muted-foreground">
              Co-assessors&rsquo; work, visible to adjudicators and admins. Open in read-only mode.
            </p>
          </div>
          <AssessmentTable rows={others} tools={tools} showAssessor onOpen={setOpenId} />
        </section>
      )}
    </div>
  );
}

function AssessmentTable({
  rows,
  tools,
  showAssessor,
  onOpen,
}: {
  rows: RobAssessment[];
  tools: RobTool[] | null;
  showAssessor: boolean;
  onOpen: (id: string) => void;
}) {
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Study</TableHead>
          <TableHead>Tool</TableHead>
          {showAssessor && <TableHead>Assessor</TableHead>}
          <TableHead>Progress</TableHead>
          <TableHead>Overall</TableHead>
          <TableHead>Status</TableHead>
          <TableHead className="w-28 text-right">Action</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((a) => {
          const domainCount = tools?.find((t) => t.id === a.toolId)?.domains.length;
          return (
            <TableRow key={a.id}>
              <TableCell className="font-medium">{a.study.label}</TableCell>
              <TableCell className="text-muted-foreground">{a.tool.name}</TableCell>
              {showAssessor && <TableCell>{a.assessor.name}</TableCell>}
              <TableCell className="tabular-nums text-muted-foreground">
                {a.judgments.length}/{domainCount ?? "?"} domains
              </TableCell>
              <TableCell>
                <JudgmentBadge scale={getScale(a.tool.judgmentScale)} value={a.overallJudgment} />
              </TableCell>
              <TableCell>
                <Badge variant={a.status === "COMPLETED" ? "include" : "maybe"}>
                  {a.status === "COMPLETED" ? "completed" : "in progress"}
                </Badge>
              </TableCell>
              <TableCell className="text-right">
                <Button variant="outline" size="sm" onClick={() => onOpen(a.id)}>
                  {a.status === "COMPLETED" ? <Eye /> : <Play />}
                  {a.status === "COMPLETED" ? "View" : "Continue"}
                </Button>
              </TableCell>
            </TableRow>
          );
        })}
      </TableBody>
    </Table>
  );
}

/** Self-start dialog: pick a study and a published tool. The server checks that the
 * caller is assigned (or may self-assign with project.edit) — 403s are surfaced. */
function StartDialog({
  tools,
  studies,
  busyKey,
  onStart,
}: {
  tools: RobTool[];
  studies: StudyRow[];
  busyKey: string | null;
  onStart: (studyId: string, toolId: string) => void;
}) {
  const publishedTools = tools.filter((t) => t.status === "PUBLISHED");
  const [open, setOpen] = useState(false);
  const [studyId, setStudyId] = useState("");
  const [toolId, setToolId] = useState("");

  const effectiveStudyId = studyId || (studies[0]?.id ?? "");
  const effectiveToolId = toolId || (publishedTools[0]?.id ?? "");

  function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!effectiveStudyId || !effectiveToolId) {
      toast.error("Pick a study and a published tool");
      return;
    }
    setOpen(false);
    onStart(effectiveStudyId, effectiveToolId);
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="sm">
          <Plus /> New assessment
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Start an assessment</DialogTitle>
          <DialogDescription>
            Resumes your existing assessment if you already started one for this study and tool.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="start-study">Study</Label>
            <Select
              id="start-study"
              value={effectiveStudyId}
              onChange={(e) => setStudyId(e.target.value)}
              disabled={studies.length === 0}
            >
              {studies.length === 0 && <option value="">No studies yet</option>}
              {studies.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.label}
                </option>
              ))}
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="start-tool">Tool (published)</Label>
            <Select
              id="start-tool"
              value={effectiveToolId}
              onChange={(e) => setToolId(e.target.value)}
              disabled={publishedTools.length === 0}
            >
              {publishedTools.length === 0 && <option value="">No published tools</option>}
              {publishedTools.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                  {t.isBuiltin ? " (built-in)" : ""}
                </option>
              ))}
            </Select>
          </div>
          <DialogFooter>
            <Button
              type="submit"
              disabled={busyKey !== null || studies.length === 0 || publishedTools.length === 0}
            >
              {busyKey !== null && <Spinner />} Start
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
