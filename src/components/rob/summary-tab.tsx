"use client";

import { useMemo, useState } from "react";
import { Gavel, LayoutGrid, Swords } from "lucide-react";
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
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { EmptyState, Skeleton, Spinner } from "@/components/ui/misc";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { JudgmentBadge, JudgmentDot, JudgmentPicker } from "./judgment";
import {
  getScale,
  scaleEntryFor,
  type JudgmentScaleEntry,
  type RobAssessment,
  type RobConflict,
  type RobTool,
} from "./types";

export function SummaryTab({
  tools,
  assessments,
  conflicts,
  conflictsVisible,
  onAdjudicated,
  projectId,
}: {
  projectId: string;
  tools: RobTool[] | null;
  assessments: RobAssessment[] | null;
  // null = still loading; conflictsVisible false = the caller cannot adjudicate,
  // so the conflict panel is hidden entirely (the API 403s the list).
  conflicts: RobConflict[] | null;
  conflictsVisible: boolean;
  onAdjudicated: () => void;
}) {
  const completed = useMemo(
    () => (assessments ?? []).filter((a) => a.status === "COMPLETED"),
    [assessments],
  );
  const toolsWithData = useMemo(() => {
    const ids = new Set(completed.map((a) => a.toolId));
    return (tools ?? []).filter((t) => ids.has(t.id));
  }, [tools, completed]);

  const [toolChoice, setToolChoice] = useState("");
  const selectedTool =
    toolsWithData.find((t) => t.id === toolChoice) ?? toolsWithData[0] ?? null;

  const loading = assessments === null || tools === null;

  return (
    <div className="space-y-8">
      <section className="space-y-3">
        {loading ? (
          <Skeleton className="h-48" />
        ) : completed.length === 0 ? (
          <EmptyState
            icon={LayoutGrid}
            title="No completed assessments yet"
            description="The traffic-light summary fills in as assessors complete their assessments. You only see assessments you are allowed to see."
          />
        ) : selectedTool === null ? (
          <EmptyState
            icon={LayoutGrid}
            title="Tool structure unavailable"
            description="Completed assessments exist, but their tool could not be loaded."
          />
        ) : (
          <TrafficLightTable
            tool={selectedTool}
            completed={completed.filter((a) => a.toolId === selectedTool.id)}
            conflicts={conflicts ?? []}
            toolPicker={
              toolsWithData.length > 1 ? (
                <div className="flex items-center gap-2">
                  <Label htmlFor="summary-tool" className="shrink-0 text-muted-foreground">
                    Tool
                  </Label>
                  <Select
                    id="summary-tool"
                    value={selectedTool.id}
                    onChange={(e) => setToolChoice(e.target.value)}
                    className="w-64"
                  >
                    {toolsWithData.map((t) => (
                      <option key={t.id} value={t.id}>
                        {t.name}
                      </option>
                    ))}
                  </Select>
                </div>
              ) : null
            }
          />
        )}
      </section>

      {conflictsVisible && (
        <ConflictsSection
          projectId={projectId}
          conflicts={conflicts}
          tools={tools}
          onAdjudicated={onAdjudicated}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Traffic-light table
// ---------------------------------------------------------------------------

function TrafficLightTable({
  tool,
  completed,
  conflicts,
  toolPicker,
}: {
  tool: RobTool;
  completed: RobAssessment[];
  conflicts: RobConflict[];
  toolPicker: React.ReactNode;
}) {
  const scale = getScale(tool.judgmentScale);

  const studies = useMemo(() => {
    const byId = new Map<string, string>();
    for (const a of completed) byId.set(a.studyId, a.study.label);
    return [...byId.entries()]
      .map(([id, label]) => ({ id, label }))
      .sort((x, y) => x.label.localeCompare(y.label));
  }, [completed]);

  // Adjudicated (RESOLVED) final judgments per study+domain (null domain = overall).
  const adjudicated = useMemo(() => {
    const map = new Map<string, string>();
    for (const c of conflicts) {
      if (c.toolId === tool.id && c.status === "RESOLVED" && c.adjudication) {
        map.set(`${c.studyId}:${c.domainId ?? "overall"}`, c.adjudication.finalJudgment);
      }
    }
    return map;
  }, [conflicts, tool.id]);

  function cell(studyId: string, domainId: string | null) {
    const final = adjudicated.get(`${studyId}:${domainId ?? "overall"}`);
    if (final !== undefined) {
      const label = scaleEntryFor(scale, final)?.label ?? final;
      return (
        <span
          className="inline-flex items-center gap-1"
          title={`Adjudicated: ${label}`}
        >
          <JudgmentDot scale={scale} value={final} />
          <Gavel className="h-3 w-3 text-muted-foreground" aria-hidden />
        </span>
      );
    }
    const perAssessor = completed
      .filter((a) => a.studyId === studyId)
      .map((a) => ({
        name: a.assessor.name,
        judgment:
          domainId === null
            ? a.overallJudgment
            : (a.judgments.find((j) => j.domainId === domainId)?.judgment ?? null),
      }))
      .filter((p): p is { name: string; judgment: string } => p.judgment !== null);
    if (perAssessor.length === 0) {
      return <span className="text-muted-foreground">—</span>;
    }
    const distinct = new Set(perAssessor.map((p) => p.judgment));
    if (distinct.size === 1) {
      const first = perAssessor[0];
      if (!first) return <span className="text-muted-foreground">—</span>;
      const label = scaleEntryFor(scale, first.judgment)?.label ?? first.judgment;
      return (
        <JudgmentDot
          scale={scale}
          value={first.judgment}
          title={`${label} — ${perAssessor.map((p) => p.name).join(", ")}`}
        />
      );
    }
    // Assessors disagree: one small dot per assessor.
    return (
      <span className="inline-flex items-center gap-0.5" title="Assessors disagree">
        {perAssessor.map((p, i) => (
          <JudgmentDot
            key={i}
            scale={scale}
            value={p.judgment}
            small
            title={`${p.name}: ${scaleEntryFor(scale, p.judgment)?.label ?? p.judgment}`}
          />
        ))}
      </span>
    );
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-lg font-medium">Traffic-light summary</h2>
          <p className="text-sm text-muted-foreground">
            {completed.length} completed assessment{completed.length === 1 ? "" : "s"} across{" "}
            {studies.length} stud{studies.length === 1 ? "y" : "ies"} · {tool.name}
          </p>
        </div>
        {toolPicker}
      </div>

      <Table>
        <TableHeader>
          <TableRow>
            <TableHead className="min-w-40">Study</TableHead>
            {tool.domains.map((d, i) => (
              <TableHead key={d.id} className="text-center">
                <span title={d.name} className="inline-block max-w-28 truncate align-middle">
                  D{i + 1}. {d.name}
                </span>
              </TableHead>
            ))}
            <TableHead className="text-center font-semibold">Overall</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {studies.map((s) => (
            <TableRow key={s.id}>
              <TableCell className="font-medium">{s.label}</TableCell>
              {tool.domains.map((d) => (
                <TableCell key={d.id} className="text-center">
                  {cell(s.id, d.id)}
                </TableCell>
              ))}
              <TableCell className="text-center">{cell(s.id, null)}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>

      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-xs text-muted-foreground">
        {scale.map((e) => (
          <span key={e.value} className="inline-flex items-center gap-1.5">
            <JudgmentDot scale={scale} value={e.value} small />
            {e.label}
          </span>
        ))}
        <span className="inline-flex items-center gap-1.5">
          <Gavel className="h-3 w-3" /> adjudicated
        </span>
        <span>Split cells show one dot per assessor when judgments disagree.</span>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Conflicts + adjudication
// ---------------------------------------------------------------------------

function ConflictsSection({
  projectId,
  conflicts,
  tools,
  onAdjudicated,
}: {
  projectId: string;
  conflicts: RobConflict[] | null;
  tools: RobTool[] | null;
  onAdjudicated: () => void;
}) {
  const [adjudicating, setAdjudicating] = useState<RobConflict | null>(null);

  const open = (conflicts ?? []).filter((c) => c.status === "OPEN");
  const resolved = (conflicts ?? []).filter((c) => c.status === "RESOLVED");
  const voidedCount = (conflicts ?? []).filter((c) => c.status === "VOIDED").length;

  function scaleFor(toolId: string): JudgmentScaleEntry[] {
    return getScale(tools?.find((t) => t.id === toolId)?.judgmentScale);
  }

  return (
    <section className="space-y-3">
      <div className="flex items-center gap-2">
        <h2 className="text-lg font-medium">Conflicts</h2>
        {open.length > 0 && <Badge variant="maybe">{open.length} open</Badge>}
      </div>
      {conflicts === null ? (
        <Skeleton className="h-24" />
      ) : conflicts.length === 0 ? (
        <EmptyState
          icon={Swords}
          title="No conflicts"
          description="Conflicts open automatically when two completed assessments disagree on a domain or on the overall judgment."
        />
      ) : (
        <div className="space-y-4">
          {open.map((c) => (
            <div key={c.id} className="rounded-lg border border-border bg-card p-4 shadow-sm">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div>
                  <p className="text-sm font-medium">
                    {c.study.label} · {c.domainName}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {c.tool.name} · opened {new Date(c.openedAt).toLocaleDateString()}
                  </p>
                </div>
                <Button size="sm" onClick={() => setAdjudicating(c)}>
                  <Gavel /> Adjudicate
                </Button>
              </div>
              <div className="mt-3 grid gap-2 sm:grid-cols-2">
                {c.assessors.map((a) => (
                  <div key={a.userId} className="rounded-md border border-border px-3 py-2">
                    <div className="flex items-center justify-between gap-2">
                      <p className="truncate text-sm font-medium">{a.name}</p>
                      <JudgmentBadge scale={scaleFor(c.toolId)} value={a.judgment} />
                    </div>
                    {a.support && (
                      <p className="mt-1 line-clamp-3 text-xs text-muted-foreground">{a.support}</p>
                    )}
                  </div>
                ))}
              </div>
            </div>
          ))}

          {resolved.length > 0 && (
            <div className="space-y-2">
              <h3 className="text-sm font-medium text-muted-foreground">Resolved</h3>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Study</TableHead>
                    <TableHead>Domain</TableHead>
                    <TableHead>Final judgment</TableHead>
                    <TableHead>Adjudicator</TableHead>
                    <TableHead>Reason</TableHead>
                    <TableHead>Resolved</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {resolved.map((c) => (
                    <TableRow key={c.id}>
                      <TableCell className="font-medium">{c.study.label}</TableCell>
                      <TableCell className="text-muted-foreground">{c.domainName}</TableCell>
                      <TableCell>
                        <JudgmentBadge
                          scale={scaleFor(c.toolId)}
                          value={c.adjudication?.finalJudgment}
                        />
                      </TableCell>
                      <TableCell>{c.adjudication?.adjudicator.name ?? "—"}</TableCell>
                      <TableCell className="max-w-56">
                        <span className="line-clamp-2 text-muted-foreground" title={c.adjudication?.reason}>
                          {c.adjudication?.reason ?? "—"}
                        </span>
                      </TableCell>
                      <TableCell className="text-muted-foreground">
                        {c.resolvedAt ? new Date(c.resolvedAt).toLocaleDateString() : "—"}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}

          {voidedCount > 0 && (
            <p className="text-xs text-muted-foreground">
              {voidedCount} conflict{voidedCount === 1 ? "" : "s"} voided (assessors now agree).
            </p>
          )}
        </div>
      )}

      {adjudicating && (
        <AdjudicateDialog
          projectId={projectId}
          conflict={adjudicating}
          scale={scaleFor(adjudicating.toolId)}
          onClose={() => setAdjudicating(null)}
          onDone={onAdjudicated}
        />
      )}
    </section>
  );
}

function AdjudicateDialog({
  projectId,
  conflict,
  scale,
  onClose,
  onDone,
}: {
  projectId: string;
  conflict: RobConflict;
  scale: JudgmentScaleEntry[];
  onClose: () => void;
  onDone: () => void;
}) {
  const [finalJudgment, setFinalJudgment] = useState<string | null>(null);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!finalJudgment) {
      toast.error("Pick a final judgment");
      return;
    }
    if (reason.trim().length < 3) {
      toast.error("Give a short reason for the decision");
      return;
    }
    setBusy(true);
    try {
      await apiPost(`/api/projects/${projectId}/rob/conflicts/${conflict.id}/adjudicate`, {
        finalJudgment,
        reason: reason.trim(),
      });
      toast.success("Conflict adjudicated");
      onDone();
      onClose();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Failed to adjudicate");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle>
            Adjudicate — {conflict.study.label} · {conflict.domainName}
          </DialogTitle>
          <DialogDescription>
            {conflict.tool.name}. The final judgment replaces the assessors&rsquo; disagreement and
            locks this {conflict.domainId === null ? "overall judgment" : "domain"}.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-2 sm:grid-cols-2">
          {conflict.assessors.map((a) => (
            <div key={a.userId} className="rounded-md border border-border px-3 py-2">
              <div className="flex items-center justify-between gap-2">
                <p className="truncate text-sm font-medium">{a.name}</p>
                <JudgmentBadge scale={scale} value={a.judgment} />
              </div>
              {a.support && (
                <p className="mt-1 line-clamp-4 text-xs text-muted-foreground">{a.support}</p>
              )}
            </div>
          ))}
        </div>
        <form onSubmit={submit} className="space-y-4">
          <div className="space-y-2">
            <Label>Final judgment</Label>
            <JudgmentPicker scale={scale} value={finalJudgment} onChange={setFinalJudgment} />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="adj-reason">Reason</Label>
            <Textarea
              id="adj-reason"
              required
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="Why this judgment stands"
            />
          </div>
          <DialogFooter>
            <Button type="submit" disabled={busy}>
              {busy ? <Spinner /> : <Gavel />} Record decision
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
