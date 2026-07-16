"use client";

// Presentational pieces for AI risk-of-bias suggestions inside the assessment workspace.
// Suggestions never decide anything — the assessor reviews the drafted judgment, quotes,
// and signaling answers and applies them into their OWN assessment (server-authoritative).

import { Sparkles, X } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { JudgmentBadge } from "./judgment";
import {
  asQuotes,
  asSignalingAnswers,
  type JudgmentScaleEntry,
  type RobSuggestionData,
} from "./types";

// Small "AI: Y" hint chip rendered beside a signaling-question select.
export function AnswerHint({
  suggestion,
  questionId,
}: {
  suggestion: RobSuggestionData | undefined;
  questionId: string;
}) {
  if (!suggestion || suggestion.notFound) return null;
  const answer = asSignalingAnswers(suggestion.signalingAnswers).find(
    (a) => a.questionId === questionId,
  );
  if (!answer || answer.invalidReason) return null;
  return (
    <span
      className="inline-flex shrink-0 items-center gap-1 rounded border border-border bg-muted/50 px-1.5 py-0.5 text-xs text-muted-foreground"
      title={answer.quote ? `“${answer.quote}”${answer.page ? ` (p. ${answer.page})` : ""}` : undefined}
    >
      <Sparkles className="h-3 w-3" /> AI: {answer.answer}
    </span>
  );
}

// Per-domain suggestion card rendered under the judgment picker — mirrors the extraction
// chip's three states: applyable / invalid (muted note) / not assessable (muted note).
export function DomainSuggestionCard({
  suggestion,
  scale,
  canApply,
  applying,
  onApply,
  onDismiss,
}: {
  suggestion: RobSuggestionData;
  scale: JudgmentScaleEntry[];
  canApply: boolean;
  applying: boolean;
  onApply: () => void;
  onDismiss: () => void;
}) {
  if (suggestion.notFound) {
    return (
      <p className="flex items-center gap-1.5 text-xs italic text-muted-foreground">
        <Sparkles className="h-3 w-3 shrink-0" /> AI: this domain could not be assessed from the
        document.
        {suggestion.rationale && <span className="not-italic"> {suggestion.rationale}</span>}
      </p>
    );
  }
  if (suggestion.invalidReason) {
    return (
      <p className="flex items-center gap-1.5 text-xs italic text-muted-foreground">
        <Sparkles className="h-3 w-3 shrink-0" /> AI suggestion couldn&apos;t be used:{" "}
        {suggestion.invalidReason}
      </p>
    );
  }
  const quotes = asQuotes(suggestion.quotes);
  return (
    <div className="space-y-1.5 rounded-md border border-border bg-muted/50 px-3 py-2 text-xs">
      <div className="flex flex-wrap items-center gap-1.5">
        <Sparkles className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        <span>AI suggests:</span>
        <JudgmentBadge scale={scale} value={suggestion.suggestedJudgment} />
        {typeof suggestion.confidence === "number" && (
          <Badge variant="secondary">{Math.round(suggestion.confidence * 100)}% confident</Badge>
        )}
        <span className="grow" />
        <Button
          variant="outline"
          size="sm"
          className="h-6 px-2 text-xs"
          disabled={!canApply || applying}
          title={
            canApply
              ? "Copy this judgment, its supporting quotes, and the signaling answers into your assessment"
              : "This domain is not editable right now"
          }
          onClick={onApply}
        >
          Apply
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
      {suggestion.rationale && <p className="text-muted-foreground">{suggestion.rationale}</p>}
      {quotes.map((quote, i) => (
        <p key={i} className="border-l-2 border-border pl-2 italic text-muted-foreground">
          &ldquo;{quote.text}&rdquo;
          {quote.page !== null ? ` (p. ${quote.page})` : ""}
        </p>
      ))}
    </div>
  );
}
