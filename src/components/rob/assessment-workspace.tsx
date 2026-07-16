"use client";

import { useEffect, useState } from "react";
import { ArrowLeft, CheckCircle2, Sparkles } from "lucide-react";
import { toast } from "sonner";
import { api, apiPatch, apiPost, apiPut, ApiError } from "@/lib/api";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { Alert, Separator, Spinner } from "@/components/ui/misc";
import { JudgmentBadge, JudgmentPicker } from "./judgment";
import { AnswerHint, DomainSuggestionCard } from "./rob-ai-suggestions";
import {
  asSignalingAnswers,
  asStringArray,
  getScale,
  type AiRobRunData,
  type AssessmentStatus,
  type ProjectAiStatus,
  type RobAssessment,
  type RobSuggestionData,
  type RobSuggestionsResponse,
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
  ai,
  onBack,
  onChanged,
}: {
  projectId: string;
  assessment: RobAssessment;
  tool: RobTool | undefined;
  meId: string | null;
  ai: ProjectAiStatus | null;
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
  // AI RoB suggestions (only loaded for the assessment's own assessor while editable).
  const [aiData, setAiData] = useState<RobSuggestionsResponse | null>(null);
  const [drafting, setDrafting] = useState(false);
  const [applyingAll, setApplyingAll] = useState(false);
  const [applyingDomain, setApplyingDomain] = useState<string | null>(null);
  const [dismissed, setDismissed] = useState<Set<string>>(new Set());

  const mine = meId !== null && assessment.assessorId === meId;
  const readOnly = status === "COMPLETED" || !mine;
  const scale = getScale(tool?.judgmentScale ?? assessment.tool.judgmentScale);
  const toolDomains = tool?.domains ?? [];
  const judgedCount = toolDomains.filter((d) => domains[d.id]?.judgment).length;
  const base = `/api/projects/${projectId}/rob/assessments/${assessment.id}`;

  const aiActive = mine && status === "IN_PROGRESS" && ai !== null && ai.enabled;
  const suggestionsUrl = `/api/projects/${projectId}/studies/${assessment.studyId}/rob-suggestions?toolId=${assessment.toolId}`;

  useEffect(() => {
    if (!aiActive) return;
    let cancelled = false;
    api<RobSuggestionsResponse>(suggestionsUrl)
      .then((resp) => {
        if (!cancelled) setAiData(resp);
      })
      .catch(() => {
        // Silent: the AI panel simply stays inert; errors surface on explicit actions.
        if (!cancelled) setAiData(null);
      });
    return () => {
      cancelled = true;
    };
  }, [aiActive, suggestionsUrl]);

  const suggestionByDomain = new Map(
    (aiData?.suggestions ?? []).map((s) => [s.domainId, s] as const),
  );

  function isApplyable(s: RobSuggestionData): boolean {
    return !s.notFound && !s.invalidReason && s.suggestedJudgment !== null;
  }

  function domainState(domainId: string): DomainState {
    return domains[domainId] ?? { judgment: null, support: "" };
  }

  async function runDraft() {
    setDrafting(true);
    try {
      const resp = await apiPost<{ run: AiRobRunData; suggestions: RobSuggestionData[] }>(
        `/api/projects/${projectId}/studies/${assessment.studyId}/rob-suggestions`,
        { toolId: assessment.toolId },
      );
      setAiData((prev) => ({
        suggestions: resp.suggestions,
        latestRun: resp.run,
        pdf: prev?.pdf ?? null,
      }));
      setDismissed(new Set());
      // Background refresh keeps the pdf info accurate (not part of the POST response).
      api<RobSuggestionsResponse>(suggestionsUrl).then(setAiData).catch(() => undefined);
      toast.success(
        `AI draft ready — ${resp.run.suggestedCount} of ${resp.run.totalDomains} domains suggested` +
          (resp.run.notFoundCount > 0
            ? `, ${resp.run.notFoundCount} not assessable from the PDF`
            : ""),
      );
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "AI risk-of-bias draft failed");
    } finally {
      setDrafting(false);
    }
  }

  // Applies the suggestion for one domain into MY assessment via the dedicated route.
  // The server copies judgment + support + valid signaling answers from the suggestion
  // row atomically; the response tells us what was written.
  async function applyDomainSuggestion(domainId: string): Promise<boolean> {
    const suggestion = suggestionByDomain.get(domainId);
    if (!suggestion) return false;
    setApplyingDomain(domainId);
    try {
      const result = await apiPost<{
        judgment: { judgment: string; support: string | null };
        responsesApplied: number;
        responsesSkipped: number;
      }>(`${base}/apply-suggestion`, { domainId });
      setDomains((prev) => ({
        ...prev,
        [domainId]: {
          judgment: result.judgment.judgment,
          support: result.judgment.support ?? "",
        },
      }));
      setSavedSupport((prev) => ({ ...prev, [domainId]: result.judgment.support ?? "" }));
      // Mirror the responses the server just wrote (valid answers only).
      setResponses((prev) => {
        const next = { ...prev };
        for (const answer of asSignalingAnswers(suggestion.signalingAnswers)) {
          if (!answer.invalidReason) next[answer.questionId] = answer.answer;
        }
        return next;
      });
      return true;
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Failed to apply AI suggestion");
      return false;
    } finally {
      setApplyingDomain(null);
    }
  }

  // Bulk apply into UNJUDGED domains only — never overwrites judgments you made.
  async function applyAllUnjudged() {
    const targets = toolDomains.filter((d) => {
      const s = suggestionByDomain.get(d.id);
      return s !== undefined && isApplyable(s) && !dismissed.has(s.id) && !domainState(d.id).judgment;
    });
    if (targets.length === 0) return;
    setApplyingAll(true);
    let applied = 0;
    for (const domain of targets) {
      if (await applyDomainSuggestion(domain.id)) applied += 1;
    }
    setApplyingAll(false);
    toast.success(`Applied ${applied} AI suggestion${applied === 1 ? "" : "s"}`);
  }

  const applyAllCount = toolDomains.filter((d) => {
    const s = suggestionByDomain.get(d.id);
    return s !== undefined && isApplyable(s) && !dismissed.has(s.id) && !domainState(d.id).judgment;
  }).length;
  const pdfMissing = aiData !== null && aiData.pdf === null;

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
        {aiActive && (
          <>
            <Button
              variant="outline"
              size="sm"
              disabled={drafting || applyingAll || pdfMissing}
              title={
                pdfMissing
                  ? "Link a PDF to this study's report on the Full text page first"
                  : "Have the AI read the study PDF and draft judgments with quoted evidence"
              }
              onClick={() => void runDraft()}
            >
              {drafting ? <Spinner className="h-3.5 w-3.5" /> : <Sparkles />}
              {drafting ? "Reading PDF…" : "AI draft"}
            </Button>
            {applyAllCount > 0 && (
              <Button
                variant="outline"
                size="sm"
                disabled={applyingAll || drafting}
                title="Apply AI suggestions to every domain you haven't judged yet"
                onClick={() => void applyAllUnjudged()}
              >
                {applyingAll && <Spinner className="h-3.5 w-3.5" />} Apply all ({applyAllCount})
              </Button>
            )}
          </>
        )}
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
                        <p className="text-sm leading-snug">
                          {q.text}{" "}
                          {aiActive && (
                            <AnswerHint
                              suggestion={
                                suggestionByDomain.get(domain.id) &&
                                !dismissed.has(suggestionByDomain.get(domain.id)!.id)
                                  ? suggestionByDomain.get(domain.id)
                                  : undefined
                              }
                              questionId={q.id}
                            />
                          )}
                        </p>
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

              {(() => {
                if (!aiActive) return null;
                const suggestion = suggestionByDomain.get(domain.id);
                if (!suggestion || dismissed.has(suggestion.id)) return null;
                return (
                  <DomainSuggestionCard
                    suggestion={suggestion}
                    scale={scale}
                    canApply={!readOnly}
                    applying={applyingDomain === domain.id || applyingAll}
                    onApply={() => void applyDomainSuggestion(domain.id)}
                    onDismiss={() => setDismissed((p) => new Set(p).add(suggestion.id))}
                  />
                );
              })()}

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
