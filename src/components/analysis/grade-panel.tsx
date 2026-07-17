"use client";

// GRADE certainty panel for one analysis outcome. The server drafts every domain
// deterministically from the pooled results (no AI in any computation); this panel
// lets analysis managers review, edit, regenerate, and mark the assessment reviewed.
// AI only proposes prose suggestions that a human explicitly applies.

import { useCallback, useEffect, useRef, useState } from "react";
import { Award, CheckCircle2, Pencil, RefreshCw, Sparkles, X } from "lucide-react";
import { toast } from "sonner";
import { api, apiPatch, apiPost } from "@/lib/api";
import { formatDateTime } from "@/lib/utils";
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
import { Label } from "@/components/ui/label";
import { Alert, EmptyState, Skeleton, Spinner } from "@/components/ui/misc";
import { Select } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { CertaintyBadge } from "./certainty-badge";
import {
  apiErrorMessages,
  DOMAIN_LABELS,
  DOMAIN_ORDER,
  JUDGMENT_META,
  ORIGIN_LABELS,
  pointsArithmetic,
  STARTING_LEVEL_LABELS,
  STARTING_POINTS,
  type GradeDomainId,
  type GradeJudgmentId,
  type GradeRatingPayload,
  type GradeStartingLevel,
  type GradeSuggestionPayload,
  type GradeView,
} from "./types";

const JUDGMENT_IDS: readonly GradeJudgmentId[] = ["NOT_SERIOUS", "SERIOUS", "VERY_SERIOUS"];

// Deduction hint for the edit dialog's judgment options.
const JUDGMENT_HINT: Record<GradeJudgmentId, string> = {
  NOT_SERIOUS: "no downgrade",
  SERIOUS: "−1",
  VERY_SERIOUS: "−2",
};

function fmtMetricValue(value: unknown): string {
  if (value === null || value === undefined) return "—";
  if (typeof value === "boolean") return value ? "yes" : "no";
  if (typeof value === "number" || typeof value === "string") return String(value);
  return JSON.stringify(value);
}

// A suggestion whose content the rating already carries was applied — don't re-offer
// it; the rating's "AI-assisted" origin chip tells the story.
function isApplied(rating: GradeRatingPayload, s: GradeSuggestionPayload): boolean {
  return (
    rating.origin === "AI_APPLIED" &&
    rating.judgment === s.suggestedJudgment &&
    rating.rationale === s.rationale
  );
}

interface EditState {
  domain: GradeDomainId;
  judgment: GradeJudgmentId;
  rationale: string;
}

export function GradePanel({
  projectId,
  outcomeId,
  canManage,
  aiEnabled,
}: {
  projectId: string;
  outcomeId: string;
  canManage: boolean;
  aiEnabled: boolean;
}) {
  const [view, setView] = useState<GradeView | null>(null);
  const [loading, setLoading] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [confirmRegen, setConfirmRegen] = useState(false);
  const [reviewing, setReviewing] = useState(false);
  const [savingLevel, setSavingLevel] = useState(false);
  const [suggesting, setSuggesting] = useState(false);
  const [applyingDomain, setApplyingDomain] = useState<GradeDomainId | null>(null);
  const [dismissed, setDismissed] = useState<Set<string>>(new Set());
  const [edit, setEdit] = useState<EditState | null>(null);
  const [savingEdit, setSavingEdit] = useState(false);

  const base = `/api/projects/${projectId}/analysis/outcomes/${outcomeId}/grade`;

  // Switching outcomes must never show the previous outcome's assessment.
  useEffect(() => {
    setView(null);
    setDismissed(new Set());
  }, [outcomeId]);

  // Request generation counter (results-table pattern): the panel survives outcome
  // switches, so only the latest request may apply its response.
  const loadSeq = useRef(0);

  const load = useCallback(
    (silent = false) => {
      const seq = ++loadSeq.current;
      const isCurrent = () => seq === loadSeq.current;
      if (!silent) setLoading(true);
      api<GradeView>(base)
        .then((data) => {
          if (isCurrent()) setView(data);
        })
        .catch((err) => {
          if (!silent && isCurrent()) toast.error(apiErrorMessages(err).join("; "));
        })
        .finally(() => {
          if (isCurrent()) setLoading(false);
        });
    },
    [base],
  );

  useEffect(() => {
    load();
  }, [load]);

  // GRADE is human-paced: refetch on window focus only — no interval poll.
  useEffect(() => {
    const onFocus = () => load(true);
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [load]);

  async function generate() {
    setGenerating(true);
    try {
      await apiPost(base, {});
      toast.success(view?.assessment ? "GRADE draft regenerated" : "GRADE draft generated");
      setConfirmRegen(false);
      load(true);
    } catch (err) {
      toast.error(apiErrorMessages(err).join("; "));
    } finally {
      setGenerating(false);
    }
  }

  async function saveStartingLevel(level: GradeStartingLevel) {
    setSavingLevel(true);
    try {
      await apiPatch(base, { startingLevel: level });
      toast.success("Starting level updated");
      load(true);
    } catch (err) {
      toast.error(apiErrorMessages(err).join("; "));
    } finally {
      setSavingLevel(false);
    }
  }

  async function markReviewed() {
    setReviewing(true);
    try {
      await apiPost(`${base}/review`);
      toast.success("Assessment marked reviewed");
      load(true);
    } catch (err) {
      toast.error(apiErrorMessages(err).join("; "));
    } finally {
      setReviewing(false);
    }
  }

  async function runSuggestions() {
    setSuggesting(true);
    try {
      const resp = await apiPost<{ suggestions: GradeSuggestionPayload[] }>(`${base}/suggestions`);
      setDismissed(new Set());
      toast.success(
        `AI drafted ${resp.suggestions.length} domain suggestion${resp.suggestions.length === 1 ? "" : "s"}`,
      );
      load(true);
    } catch (err) {
      toast.error(apiErrorMessages(err).join("; "));
    } finally {
      setSuggesting(false);
    }
  }

  // Server-authoritative apply: judgment/rationale are copied from the suggestion row.
  async function applySuggestion(s: GradeSuggestionPayload) {
    setApplyingDomain(s.domain);
    try {
      await apiPatch(`${base}/ratings/${s.domain}`, { appliedSuggestionId: s.id });
      toast.success(`${DOMAIN_LABELS[s.domain]} updated from the AI suggestion`);
      setDismissed((prev) => new Set(prev).add(s.id));
      load(true);
    } catch (err) {
      toast.error(apiErrorMessages(err).join("; "));
    } finally {
      setApplyingDomain(null);
    }
  }

  async function saveEdit() {
    if (!edit) return;
    setSavingEdit(true);
    try {
      await apiPatch(`${base}/ratings/${edit.domain}`, {
        judgment: edit.judgment,
        rationale: edit.rationale.trim(),
      });
      toast.success(`${DOMAIN_LABELS[edit.domain]} saved`);
      setEdit(null);
      load(true);
    } catch (err) {
      toast.error(apiErrorMessages(err).join("; "));
    } finally {
      setSavingEdit(false);
    }
  }

  if (view === null) {
    return <Skeleton className="h-64" />;
  }

  const assessment = view.assessment;

  if (assessment === null) {
    return (
      <EmptyState
        icon={Award}
        title="No GRADE assessment yet"
        description={
          view.canDraft
            ? canManage
              ? "Generate a deterministic draft from the pooled results — every judgment stays editable, and no AI is involved in the computation."
              : "A statistician or admin generates the certainty draft here."
            : "GRADE needs at least one pooled study for this outcome — complete the field mappings and extraction first."
        }
        action={
          canManage ? (
            <Button onClick={() => void generate()} disabled={generating || !view.canDraft}>
              {generating && <Spinner />} Generate draft
            </Button>
          ) : undefined
        }
      />
    );
  }

  const suggestionByDomain = new Map(view.suggestions.map((s) => [s.domain, s] as const));
  const ratingByDomain = new Map(assessment.ratings.map((r) => [r.domain, r] as const));
  const reviewed = assessment.status === "REVIEWED";
  const outOfDate = view.outOfDate;

  return (
    <div className="space-y-6">
      {view.sourceUnavailable ? (
        <Alert variant="warning">
          The pooled result is no longer available — no study currently contributes. Restore the
          evidence before reviewing or regenerating this GRADE assessment.
        </Alert>
      ) : view.outOfDate ? (
        <Alert variant="warning">
          {view.staleDomains.length > 0
            ? `Results changed since this draft — regenerate to refresh ${view.staleDomains
                .map((d) => DOMAIN_LABELS[d])
                .join(", ")}.`
            : "The analysis outcome or protocol applicability context changed since this draft — regenerate GRADE before using it."}
        </Alert>
      ) : null}

      <Card>
        <CardHeader>
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <CardTitle className="text-base">GRADE certainty</CardTitle>
              <CardDescription>
                Deterministic draft from the pooled results — every judgment stays
                human-editable.
              </CardDescription>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              {aiEnabled && canManage && (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => void runSuggestions()}
                  disabled={suggesting || outOfDate}
                  title={
                    outOfDate
                      ? "Regenerate the out-of-date GRADE draft before requesting AI suggestions"
                      : "Draft per-domain prose suggestions from the deterministic metrics and the protocol PICO"
                  }
                >
                  {suggesting ? <Spinner className="h-3.5 w-3.5" /> : <Sparkles />} AI suggestions
                </Button>
              )}
              {canManage && !reviewed && (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => void markReviewed()}
                  disabled={reviewing || outOfDate}
                  title={
                    view.sourceUnavailable
                      ? "Restore the pooled evidence before reviewing"
                      : view.outOfDate
                        ? "Regenerate the stale GRADE draft before reviewing"
                        : undefined
                  }
                >
                  {reviewing ? <Spinner className="h-3.5 w-3.5" /> : <CheckCircle2 />} Mark
                  reviewed
                </Button>
              )}
              {canManage && (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setConfirmRegen(true)}
                  disabled={generating || loading || !view.canDraft}
                  title={
                    view.canDraft
                      ? "Refresh the automatic ratings from the current pooled results"
                      : "No pooled result to draft from"
                  }
                >
                  <RefreshCw /> Regenerate draft
                </Button>
              )}
            </div>
          </div>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex flex-wrap items-center gap-3">
            <CertaintyBadge certainty={assessment.certainty} className="text-sm" />
            {outOfDate && <span className="text-xs font-medium text-exclude">(out of date)</span>}
            <p className="text-sm tabular-nums text-muted-foreground">
              {pointsArithmetic(assessment.startingLevel, assessment.points, assessment.certainty)}
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
            {outOfDate ? (
              <>
                <Badge variant="exclude">
                  {view.sourceUnavailable ? "Source unavailable" : "Out of date"}
                </Badge>
                {reviewed && (
                  <span>
                    Last reviewed by {assessment.reviewedBy?.name ?? "unknown"}
                    {assessment.reviewedAt ? ` — ${formatDateTime(assessment.reviewedAt)}` : ""}
                  </span>
                )}
              </>
            ) : reviewed ? (
              <>
                <Badge variant="include">Reviewed</Badge>
                <span>
                  by {assessment.reviewedBy?.name ?? "unknown"}
                  {assessment.reviewedAt ? ` — ${formatDateTime(assessment.reviewedAt)}` : ""}
                </span>
              </>
            ) : (
              <Badge variant="maybe">Draft</Badge>
            )}
            <span>Generated {formatDateTime(assessment.generatedAt)}</span>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Label htmlFor="grade-starting-level" className="shrink-0">
              Starting level
            </Label>
            <Select
              id="grade-starting-level"
              className="w-72"
              value={assessment.startingLevel}
              onChange={(e) => void saveStartingLevel(e.target.value as GradeStartingLevel)}
              disabled={!canManage || savingLevel}
            >
              {(["HIGH", "LOW"] as const).map((level) => (
                <option key={level} value={level}>
                  {STARTING_LEVEL_LABELS[level]} ({STARTING_POINTS[level]} points)
                </option>
              ))}
            </Select>
            {savingLevel && <Spinner className="h-3.5 w-3.5" />}
          </div>
          {aiEnabled && view.latestRun?.status === "FAILED" && (
            <p className="text-xs text-exclude">
              Last AI suggestion run failed{view.latestRun.error ? `: ${view.latestRun.error}` : ""}
              .
            </p>
          )}
        </CardContent>
      </Card>

      <div className="space-y-4">
        {DOMAIN_ORDER.map((domain) => {
          const rating = ratingByDomain.get(domain);
          if (!rating) return null;
          const jm = JUDGMENT_META[rating.judgment];
          const suggestion = suggestionByDomain.get(domain);
          const showSuggestion =
            aiEnabled &&
            canManage &&
            suggestion !== undefined &&
            !dismissed.has(suggestion.id) &&
            !isApplied(rating, suggestion);
          const metricEntries = rating.metrics ? Object.entries(rating.metrics) : [];
          return (
            <Card key={domain}>
              <CardHeader className="pb-0">
                <div className="flex flex-wrap items-center gap-2">
                  <CardTitle className="text-sm">{DOMAIN_LABELS[domain]}</CardTitle>
                  <Badge variant={jm.variant}>{jm.label}</Badge>
                  <Badge variant="outline" className="text-muted-foreground">
                    {ORIGIN_LABELS[rating.origin]}
                  </Badge>
                  {rating.requiresReview && !reviewed && (
                    <Badge variant="maybe">Needs review</Badge>
                  )}
                  <span className="grow" />
                  {canManage && (
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-7 px-2 text-xs"
                      aria-label={`Edit ${DOMAIN_LABELS[domain]}`}
                      onClick={() =>
                        setEdit({
                          domain,
                          judgment: rating.judgment,
                          rationale: rating.rationale,
                        })
                      }
                    >
                      <Pencil className="h-3.5 w-3.5" /> Edit
                    </Button>
                  )}
                </div>
              </CardHeader>
              <CardContent className="space-y-2 pt-3">
                <p className="text-sm">{rating.rationale}</p>
                {metricEntries.length > 0 && (
                  <details className="text-xs">
                    <summary className="cursor-pointer text-muted-foreground hover:text-foreground">
                      Metrics
                    </summary>
                    <dl className="mt-2 space-y-1">
                      {metricEntries.map(([key, value]) => (
                        <div key={key} className="flex gap-2">
                          <dt className="shrink-0 font-medium text-muted-foreground">{key}</dt>
                          <dd className="min-w-0 break-all tabular-nums">
                            {fmtMetricValue(value)}
                          </dd>
                        </div>
                      ))}
                    </dl>
                  </details>
                )}
                {showSuggestion && (
                  <GradeSuggestionCard
                    suggestion={suggestion}
                    applying={applyingDomain === domain}
                    onApply={() => void applySuggestion(suggestion)}
                    onDismiss={() =>
                      setDismissed((prev) => new Set(prev).add(suggestion.id))
                    }
                  />
                )}
              </CardContent>
            </Card>
          );
        })}
      </div>

      <Dialog
        open={confirmRegen}
        onOpenChange={(open) => {
          if (!open) setConfirmRegen(false);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Regenerate GRADE draft?</DialogTitle>
            <DialogDescription>
              Automatic ratings are refreshed from the current pooled results. Domains you
              edited or filled from an AI suggestion are preserved untouched; the overall
              certainty is recomputed and the assessment returns to draft.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirmRegen(false)} disabled={generating}>
              Cancel
            </Button>
            <Button onClick={() => void generate()} disabled={generating}>
              {generating && <Spinner />} Regenerate
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={edit !== null}
        onOpenChange={(open) => {
          if (!open) setEdit(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Edit {edit ? DOMAIN_LABELS[edit.domain] : "rating"}</DialogTitle>
            <DialogDescription>
              Your judgment and rationale replace the automated draft for this domain — it
              will show as &ldquo;Edited&rdquo; and survive regeneration.
            </DialogDescription>
          </DialogHeader>
          {edit && (
            <div className="space-y-4">
              <div className="space-y-1.5">
                <Label htmlFor="grade-edit-judgment">Judgment</Label>
                <Select
                  id="grade-edit-judgment"
                  value={edit.judgment}
                  onChange={(e) =>
                    setEdit({ ...edit, judgment: e.target.value as GradeJudgmentId })
                  }
                >
                  {JUDGMENT_IDS.map((j) => (
                    <option key={j} value={j}>
                      {JUDGMENT_META[j].label} ({JUDGMENT_HINT[j]})
                    </option>
                  ))}
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="grade-edit-rationale">Rationale</Label>
                <Textarea
                  id="grade-edit-rationale"
                  rows={5}
                  value={edit.rationale}
                  onChange={(e) => setEdit({ ...edit, rationale: e.target.value })}
                  placeholder="Why this domain is (or is not) a concern for this outcome"
                />
              </div>
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setEdit(null)} disabled={savingEdit}>
              Cancel
            </Button>
            <Button
              onClick={() => void saveEdit()}
              disabled={savingEdit || !edit || edit.rationale.trim().length === 0}
            >
              {savingEdit && <Spinner />} Save
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

// Per-domain AI suggestion card — mirrors the RoB workspace's suggestion card. Apply is
// server-authoritative (the rating is written from the suggestion row, never the client).
function GradeSuggestionCard({
  suggestion,
  applying,
  onApply,
  onDismiss,
}: {
  suggestion: GradeSuggestionPayload;
  applying: boolean;
  onApply: () => void;
  onDismiss: () => void;
}) {
  const jm = JUDGMENT_META[suggestion.suggestedJudgment];
  return (
    <div className="space-y-1.5 rounded-md border border-border bg-muted/50 px-3 py-2 text-xs">
      <div className="flex flex-wrap items-center gap-1.5">
        <Sparkles className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        <span>AI suggests:</span>
        <Badge variant={jm.variant}>{jm.label}</Badge>
        {typeof suggestion.confidence === "number" && (
          <Badge variant="secondary">{Math.round(suggestion.confidence * 100)}% confident</Badge>
        )}
        <span className="grow" />
        <Button
          variant="outline"
          size="sm"
          className="h-6 px-2 text-xs"
          disabled={applying}
          title="Copy this judgment and rationale into the domain rating"
          onClick={onApply}
        >
          {applying && <Spinner className="h-3 w-3" />} Apply
        </Button>
        <Button
          variant="ghost"
          size="sm"
          className="h-6 px-1.5 text-xs"
          aria-label="Dismiss suggestion"
          onClick={onDismiss}
        >
          <X className="h-3 w-3" />
        </Button>
      </div>
      <p className="text-muted-foreground">{suggestion.rationale}</p>
    </div>
  );
}
