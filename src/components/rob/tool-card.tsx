"use client";

import { useState } from "react";
import { CheckCircle2, ChevronDown, ChevronRight, Copy, Pencil, Plus, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { apiDelete, apiPatch, apiPost, ApiError } from "@/lib/api";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Spinner } from "@/components/ui/misc";
import { JudgmentBadge } from "./judgment";
import { asStringArray, getScale, type RobDomain, type RobQuestion, type RobTool } from "./types";

const STATUS_VARIANT = {
  DRAFT: "maybe",
  PUBLISHED: "include",
  ARCHIVED: "muted",
} as const;

export function ToolCard({
  projectId,
  tool,
  canManage,
  onChanged,
}: {
  projectId: string;
  tool: RobTool;
  canManage: boolean;
  onChanged: () => void;
}) {
  // Structure is only editable on the project's own DRAFT tools. The server
  // additionally freezes structure once any assessment exists — we surface
  // that error rather than trying to predict it client-side.
  const editable = canManage && !tool.isBuiltin && tool.projectId !== null && tool.status === "DRAFT";
  const [expanded, setExpanded] = useState(editable);
  const [busy, setBusy] = useState<string | null>(null);
  const [domainDialog, setDomainDialog] = useState<{ domain?: RobDomain } | null>(null);
  const [questionDialog, setQuestionDialog] = useState<{
    domainId: string;
    question?: RobQuestion;
  } | null>(null);

  const scale = getScale(tool.judgmentScale);
  const questionCount = tool.domains.reduce((n, d) => n + d.questions.length, 0);
  const base = `/api/projects/${projectId}/rob/tools/${tool.id}`;

  async function run(key: string, fn: () => Promise<unknown>, success: string) {
    setBusy(key);
    try {
      await fn();
      toast.success(success);
      onChanged();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Something went wrong");
    } finally {
      setBusy(null);
    }
  }

  function deleteDomain(domain: RobDomain) {
    if (!window.confirm(`Delete domain "${domain.name}" and its questions?`)) return;
    void run("del-domain", () => apiDelete(`${base}/domains/${domain.id}`), "Domain deleted");
  }

  function deleteQuestion(domainId: string, question: RobQuestion) {
    if (!window.confirm("Delete this signaling question?")) return;
    void run(
      "del-question",
      () => apiDelete(`${base}/domains/${domainId}/questions/${question.id}`),
      "Question deleted",
    );
  }

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div className="min-w-0">
            <CardTitle className="text-base leading-snug">{tool.name}</CardTitle>
            {tool.description && (
              <CardDescription className="mt-1">{tool.description}</CardDescription>
            )}
          </div>
          <div className="flex shrink-0 items-center gap-1.5">
            {tool.isBuiltin ? (
              <Badge variant="secondary">Built-in</Badge>
            ) : (
              <Badge variant={STATUS_VARIANT[tool.status]}>{tool.status.toLowerCase()}</Badge>
            )}
          </div>
        </div>
        {scale.length > 0 && (
          <div className="flex flex-wrap gap-1.5 pt-1">
            {scale.map((entry) => (
              <JudgmentBadge key={entry.value} scale={scale} value={entry.value} />
            ))}
          </div>
        )}
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={() => setExpanded((v) => !v)}
            className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
          >
            {expanded ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
            {tool.domains.length} domain{tool.domains.length === 1 ? "" : "s"} · {questionCount}{" "}
            question{questionCount === 1 ? "" : "s"}
          </button>
          <div className="flex-1" />
          {editable && (
            <Button variant="outline" size="sm" onClick={() => setDomainDialog({})}>
              <Plus /> Add domain
            </Button>
          )}
          {editable && (
            <Button
              size="sm"
              disabled={busy !== null}
              onClick={() => void run("publish", () => apiPost(`${base}/publish`), "Tool published")}
            >
              {busy === "publish" ? <Spinner /> : <CheckCircle2 />} Publish
            </Button>
          )}
          {canManage && (
            <Button
              variant="outline"
              size="sm"
              disabled={busy !== null}
              onClick={() =>
                void run(
                  "clone",
                  () => apiPost(`${base}/clone`),
                  "Cloned into this project as a draft",
                )
              }
            >
              {busy === "clone" ? <Spinner /> : <Copy />}{" "}
              {tool.isBuiltin ? "Use this tool" : "Clone"}
            </Button>
          )}
        </div>

        {expanded &&
          (tool.domains.length === 0 ? (
            <p className="text-sm italic text-muted-foreground">
              No domains yet{editable ? " — add at least one before publishing." : "."}
            </p>
          ) : (
            <div className="space-y-2.5">
              {tool.domains.map((domain, i) => (
                <div key={domain.id} className="rounded-md border border-border">
                  <div className="flex items-start justify-between gap-2 border-b border-border bg-muted/40 px-3 py-2">
                    <div className="min-w-0">
                      <p className="text-sm font-medium">
                        <span className="text-muted-foreground">D{i + 1}.</span> {domain.name}
                      </p>
                      {domain.guidance && (
                        <p className="mt-0.5 text-xs text-muted-foreground">{domain.guidance}</p>
                      )}
                    </div>
                    {editable && (
                      <div className="flex shrink-0 gap-0.5">
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-7 w-7"
                          aria-label={`Edit domain ${domain.name}`}
                          onClick={() => setDomainDialog({ domain })}
                        >
                          <Pencil />
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-7 w-7 text-exclude hover:text-exclude"
                          aria-label={`Delete domain ${domain.name}`}
                          disabled={busy !== null}
                          onClick={() => deleteDomain(domain)}
                        >
                          <Trash2 />
                        </Button>
                      </div>
                    )}
                  </div>
                  <div className="divide-y divide-border">
                    {domain.questions.map((q) => (
                      <div key={q.id} className="flex items-start justify-between gap-2 px-3 py-2">
                        <div className="min-w-0">
                          <p className="text-sm leading-snug">{q.text}</p>
                          {q.guidance && (
                            <p className="mt-0.5 text-xs text-muted-foreground">{q.guidance}</p>
                          )}
                          <div className="mt-1.5 flex flex-wrap gap-1">
                            {asStringArray(q.allowedAnswers).map((a) => (
                              <Badge key={a} variant="outline" className="px-1.5 py-0">
                                {a}
                              </Badge>
                            ))}
                          </div>
                        </div>
                        {editable && (
                          <div className="flex shrink-0 gap-0.5">
                            <Button
                              variant="ghost"
                              size="icon"
                              className="h-7 w-7"
                              aria-label="Edit question"
                              onClick={() =>
                                setQuestionDialog({ domainId: domain.id, question: q })
                              }
                            >
                              <Pencil />
                            </Button>
                            <Button
                              variant="ghost"
                              size="icon"
                              className="h-7 w-7 text-exclude hover:text-exclude"
                              aria-label="Delete question"
                              disabled={busy !== null}
                              onClick={() => deleteQuestion(domain.id, q)}
                            >
                              <Trash2 />
                            </Button>
                          </div>
                        )}
                      </div>
                    ))}
                    {domain.questions.length === 0 && (
                      <p className="px-3 py-2 text-xs italic text-muted-foreground">
                        No signaling questions.
                      </p>
                    )}
                    {editable && (
                      <div className="px-3 py-1.5">
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => setQuestionDialog({ domainId: domain.id })}
                        >
                          <Plus /> Add question
                        </Button>
                      </div>
                    )}
                  </div>
                </div>
              ))}
            </div>
          ))}
      </CardContent>

      {domainDialog && (
        <DomainDialog
          base={base}
          domain={domainDialog.domain}
          onClose={() => setDomainDialog(null)}
          onSaved={onChanged}
        />
      )}
      {questionDialog && (
        <QuestionDialog
          base={base}
          domainId={questionDialog.domainId}
          question={questionDialog.question}
          onClose={() => setQuestionDialog(null)}
          onSaved={onChanged}
        />
      )}
    </Card>
  );
}

function DomainDialog({
  base,
  domain,
  onClose,
  onSaved,
}: {
  base: string;
  domain?: RobDomain;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [name, setName] = useState(domain?.name ?? "");
  const [guidance, setGuidance] = useState(domain?.guidance ?? "");
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      if (domain) {
        await apiPatch(`${base}/domains/${domain.id}`, {
          name: name.trim(),
          guidance: guidance.trim() === "" ? null : guidance.trim(),
        });
      } else {
        await apiPost(`${base}/domains`, {
          name: name.trim(),
          ...(guidance.trim() ? { guidance: guidance.trim() } : {}),
        });
      }
      toast.success(domain ? "Domain updated" : "Domain added");
      onSaved();
      onClose();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Failed to save domain");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{domain ? "Edit domain" : "Add domain"}</DialogTitle>
        </DialogHeader>
        <form onSubmit={submit} className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="domain-name">Name</Label>
            <Input
              id="domain-name"
              required
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Selection bias"
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="domain-guidance">Guidance (optional)</Label>
            <Textarea
              id="domain-guidance"
              value={guidance}
              onChange={(e) => setGuidance(e.target.value)}
              placeholder="What assessors should consider in this domain"
            />
          </div>
          <DialogFooter>
            <Button type="submit" disabled={busy}>
              {busy && <Spinner />} {domain ? "Save changes" : "Add domain"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

const DEFAULT_ANSWERS = "Y, PY, PN, N, NI";

function QuestionDialog({
  base,
  domainId,
  question,
  onClose,
  onSaved,
}: {
  base: string;
  domainId: string;
  question?: RobQuestion;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [text, setText] = useState(question?.text ?? "");
  const [guidance, setGuidance] = useState(question?.guidance ?? "");
  const [answers, setAnswers] = useState(
    question ? asStringArray(question.allowedAnswers).join(", ") : DEFAULT_ANSWERS,
  );
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const allowedAnswers = answers
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    if (allowedAnswers.length < 2) {
      toast.error("Provide at least two allowed answers, separated by commas");
      return;
    }
    if (new Set(allowedAnswers).size !== allowedAnswers.length) {
      toast.error("Allowed answers must be unique");
      return;
    }
    setBusy(true);
    try {
      if (question) {
        await apiPatch(`${base}/domains/${domainId}/questions/${question.id}`, {
          text: text.trim(),
          guidance: guidance.trim() === "" ? null : guidance.trim(),
          allowedAnswers,
        });
      } else {
        await apiPost(`${base}/domains/${domainId}/questions`, {
          text: text.trim(),
          ...(guidance.trim() ? { guidance: guidance.trim() } : {}),
          allowedAnswers,
        });
      }
      toast.success(question ? "Question updated" : "Question added");
      onSaved();
      onClose();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Failed to save question");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{question ? "Edit signaling question" : "Add signaling question"}</DialogTitle>
          <DialogDescription>
            Assessors answer signaling questions before judging the domain.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="q-text">Question</Label>
            <Textarea
              id="q-text"
              required
              value={text}
              onChange={(e) => setText(e.target.value)}
              placeholder="e.g. Was the allocation sequence adequately generated?"
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="q-guidance">Guidance (optional)</Label>
            <Textarea
              id="q-guidance"
              value={guidance}
              onChange={(e) => setGuidance(e.target.value)}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="q-answers">Allowed answers (comma-separated)</Label>
            <Input
              id="q-answers"
              required
              value={answers}
              onChange={(e) => setAnswers(e.target.value)}
              placeholder={DEFAULT_ANSWERS}
            />
            <p className="text-xs text-muted-foreground">
              Y = yes, PY = probably yes, PN = probably no, N = no, NI = no information.
            </p>
          </div>
          <DialogFooter>
            <Button type="submit" disabled={busy}>
              {busy && <Spinner />} {question ? "Save changes" : "Add question"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
