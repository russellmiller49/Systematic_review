"use client";

import { useState } from "react";
import { ArrowLeft, CheckCircle2 } from "lucide-react";
import { toast } from "sonner";
import { apiPatch, apiPost, apiPut, ApiError } from "@/lib/api";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { Alert, Separator, Spinner } from "@/components/ui/misc";
import { JudgmentBadge, JudgmentPicker } from "./judgment";
import {
  asStringArray,
  getScale,
  type AssessmentStatus,
  type RobAssessment,
  type RobTool,
} from "./types";

interface DomainState {
  judgment: string | null;
  support: string;
}

function missingDomainsFrom(err: unknown): string[] {
  if (err instanceof ApiError && err.details && typeof err.details === "object") {
    const raw = (err.details as { missingDomains?: unknown }).missingDomains;
    if (Array.isArray(raw)) return raw.filter((x): x is string => typeof x === "string");
  }
  return [];
}

export function AssessmentWorkspace({
  projectId,
  assessment,
  tool,
  meId,
  onBack,
  onChanged,
}: {
  projectId: string;
  assessment: RobAssessment;
  tool: RobTool | undefined;
  meId: string | null;
  onBack: () => void;
  onChanged: () => void;
}) {
  const [status, setStatus] = useState<AssessmentStatus>(assessment.status);
  const [responses, setResponses] = useState<Record<string, string>>(() =>
    Object.fromEntries(assessment.responses.map((r) => [r.questionId, r.answer])),
  );
  const [domains, setDomains] = useState<Record<string, DomainState>>(() =>
    Object.fromEntries(
      assessment.judgments.map((j) => [
        j.domainId,
        { judgment: j.judgment, support: j.support ?? "" },
      ]),
    ),
  );
  const [savedSupport, setSavedSupport] = useState<Record<string, string>>(() =>
    Object.fromEntries(assessment.judgments.map((j) => [j.domainId, j.support ?? ""])),
  );
  const [overall, setOverall] = useState<string | null>(assessment.overallJudgment);
  const [savingKey, setSavingKey] = useState<string | null>(null);
  const [completing, setCompleting] = useState(false);

  const mine = meId !== null && assessment.assessorId === meId;
  const readOnly = status === "COMPLETED" || !mine;
  const scale = getScale(tool?.judgmentScale ?? assessment.tool.judgmentScale);
  const toolDomains = tool?.domains ?? [];
  const judgedCount = toolDomains.filter((d) => domains[d.id]?.judgment).length;
  const base = `/api/projects/${projectId}/rob/assessments/${assessment.id}`;

  function domainState(domainId: string): DomainState {
    return domains[domainId] ?? { judgment: null, support: "" };
  }

  async function saveAnswer(questionId: string, answer: string) {
    const previous = responses[questionId];
    setResponses((prev) => ({ ...prev, [questionId]: answer }));
    setSavingKey(`q:${questionId}`);
    try {
      await apiPut(`${base}/responses/${questionId}`, { answer });
      toast.success("Answer saved");
    } catch (err) {
      setResponses((prev) => {
        const next = { ...prev };
        if (previous === undefined) delete next[questionId];
        else next[questionId] = previous;
        return next;
      });
      toast.error(err instanceof ApiError ? err.message : "Failed to save answer");
    } finally {
      setSavingKey(null);
    }
  }

  async function saveJudgment(domainId: string, judgment: string) {
    const state = domainState(domainId);
    setSavingKey(`d:${domainId}`);
    try {
      await apiPut(`${base}/judgments/${domainId}`, {
        judgment,
        support: state.support.trim() === "" ? null : state.support,
      });
      setDomains((prev) => ({ ...prev, [domainId]: { ...state, judgment } }));
      setSavedSupport((prev) => ({ ...prev, [domainId]: state.support }));
      toast.success("Judgment saved");
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Failed to save judgment");
    } finally {
      setSavingKey(null);
    }
  }

  async function saveSupport(domainId: string) {
    const state = domainState(domainId);
    if (!state.judgment) return;
    setSavingKey(`s:${domainId}`);
    try {
      await apiPut(`${base}/judgments/${domainId}`, {
        judgment: state.judgment,
        support: state.support.trim() === "" ? null : state.support,
      });
      setSavedSupport((prev) => ({ ...prev, [domainId]: state.support }));
      toast.success("Support saved");
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Failed to save support");
    } finally {
      setSavingKey(null);
    }
  }

  async function saveOverall(judgment: string) {
    setSavingKey("overall");
    try {
      await apiPatch(base, { overallJudgment: judgment });
      setOverall(judgment);
      toast.success("Overall judgment saved");
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Failed to save overall judgment");
    } finally {
      setSavingKey(null);
    }
  }

  async function complete() {
    setCompleting(true);
    try {
      await apiPost(`${base}/complete`);
      setStatus("COMPLETED");
      toast.success("Assessment completed");
      onChanged();
    } catch (err) {
      const missing = missingDomainsFrom(err);
      toast.error(
        err instanceof ApiError
          ? err.message + (missing.length > 0 ? `: ${missing.join(", ")}` : "")
          : "Failed to complete assessment",
      );
    } finally {
      setCompleting(false);
    }
  }

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center gap-3">
        <Button variant="ghost" size="sm" onClick={onBack}>
          <ArrowLeft /> Back
        </Button>
        <div className="min-w-0">
          <h2 className="text-lg font-semibold leading-tight">{assessment.study.label}</h2>
          <p className="text-sm text-muted-foreground">
            {assessment.tool.name}
            {!mine && ` · assessed by ${assessment.assessor.name}`}
          </p>
        </div>
        <div className="flex-1" />
        <Badge variant={status === "COMPLETED" ? "include" : "maybe"}>
          {status === "COMPLETED" ? "completed" : "in progress"}
        </Badge>
      </div>

      {status === "COMPLETED" ? (
        <Alert variant="success">
          This assessment was completed
          {assessment.completedAt
            ? ` on ${new Date(assessment.completedAt).toLocaleString()}`
            : ""}{" "}
          and is read-only.
        </Alert>
      ) : !mine ? (
        <Alert variant="info">
          You are viewing {assessment.assessor.name}&rsquo;s assessment — only the assessor can
          edit it.
        </Alert>
      ) : null}

      {!tool && (
        <Alert variant="warning">
          The tool&rsquo;s structure could not be loaded, so domains and questions cannot be shown.
        </Alert>
      )}

      {toolDomains.map((domain, i) => {
        const state = domainState(domain.id);
        const supportDirty = state.support !== (savedSupport[domain.id] ?? "");
        return (
          <Card key={domain.id}>
            <CardHeader className="pb-3">
              <div className="flex flex-wrap items-start justify-between gap-2">
                <CardTitle className="text-base">
                  <span className="text-muted-foreground">Domain {i + 1}.</span> {domain.name}
                </CardTitle>
                <JudgmentBadge scale={scale} value={state.judgment} />
              </div>
              {domain.guidance && <CardDescription>{domain.guidance}</CardDescription>}
            </CardHeader>
            <CardContent className="space-y-4">
              {domain.questions.length > 0 && (
                <div className="space-y-3">
                  {domain.questions.map((q) => (
                    <div
                      key={q.id}
                      className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between"
                    >
                      <div className="min-w-0">
                        <p className="text-sm leading-snug">{q.text}</p>
                        {q.guidance && (
                          <p className="mt-0.5 text-xs text-muted-foreground">{q.guidance}</p>
                        )}
                      </div>
                      <div className="w-full shrink-0 sm:w-44">
                        <Select
                          value={responses[q.id] ?? ""}
                          onChange={(e) => void saveAnswer(q.id, e.target.value)}
                          disabled={readOnly || savingKey === `q:${q.id}`}
                          aria-label={`Answer: ${q.text}`}
                        >
                          <option value="" disabled>
                            Select answer
                          </option>
                          {asStringArray(q.allowedAnswers).map((a) => (
                            <option key={a} value={a}>
                              {a}
                            </option>
                          ))}
                        </Select>
                      </div>
                    </div>
                  ))}
                </div>
              )}

              <Separator />

              <div className="space-y-2">
                <Label>Domain judgment</Label>
                <JudgmentPicker
                  scale={scale}
                  value={state.judgment}
                  disabled={readOnly || savingKey === `d:${domain.id}`}
                  onChange={(v) => void saveJudgment(domain.id, v)}
                />
              </div>

              <div className="space-y-2">
                <Label htmlFor={`support-${domain.id}`}>Support for judgment</Label>
                <Textarea
                  id={`support-${domain.id}`}
                  value={state.support}
                  disabled={readOnly}
                  placeholder="Quote or describe the evidence behind this judgment (optional)"
                  onChange={(e) =>
                    setDomains((prev) => ({
                      ...prev,
                      [domain.id]: { ...domainState(domain.id), support: e.target.value },
                    }))
                  }
                />
                {!readOnly && supportDirty && (
                  <div className="flex items-center gap-2">
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={!state.judgment || savingKey === `s:${domain.id}`}
                      onClick={() => void saveSupport(domain.id)}
                    >
                      {savingKey === `s:${domain.id}` && <Spinner />} Save support
                    </Button>
                    {!state.judgment && (
                      <p className="text-xs text-muted-foreground">
                        Pick a judgment first — support is saved with it.
                      </p>
                    )}
                  </div>
                )}
              </div>
            </CardContent>
          </Card>
        );
      })}

      {tool && (
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base">Overall judgment</CardTitle>
            <CardDescription>
              {judgedCount}/{toolDomains.length} domains judged. The overall judgment is optional
              but recommended.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <JudgmentPicker
              scale={scale}
              value={overall}
              disabled={readOnly || savingKey === "overall"}
              onChange={(v) => void saveOverall(v)}
            />
            {!readOnly && (
              <div className="flex items-center gap-3">
                <Button
                  disabled={completing || judgedCount < toolDomains.length}
                  onClick={() => void complete()}
                >
                  {completing ? <Spinner /> : <CheckCircle2 />} Complete assessment
                </Button>
                {judgedCount < toolDomains.length && (
                  <p className="text-xs text-muted-foreground">
                    Every domain needs a judgment before completing.
                  </p>
                )}
              </div>
            )}
          </CardContent>
        </Card>
      )}
    </div>
  );
}
