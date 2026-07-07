"use client";

import { EyeOff, Flag, Gavel, RotateCcw } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Alert } from "@/components/ui/misc";
import { CitationCard } from "@/components/citations/citation-card";
import {
  CONFLICT_STATUS_BADGE_VARIANT,
  DECISION_BADGE_VARIANT,
  type ConflictAdjudication,
  type ConflictDecision,
  type ConflictRow,
} from "@/components/conflicts/types";

export function ConflictItem({
  conflict,
  onAdjudicate,
  onReopen,
}: {
  conflict: ConflictRow;
  onAdjudicate: () => void;
  onReopen: () => void;
}) {
  const decisions = conflict.decisions ?? [];

  return (
    <CitationCard citation={conflict.citation}>
      <div className="space-y-3">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1.5">
          <Badge variant={CONFLICT_STATUS_BADGE_VARIANT[conflict.status]}>
            {conflict.status.toLowerCase()}
          </Badge>
          <span className="text-xs text-muted-foreground">
            Opened {new Date(conflict.openedAt).toLocaleString()}
            {conflict.resolvedAt &&
              ` · Resolved ${new Date(conflict.resolvedAt).toLocaleString()}`}
          </span>
          <div className="ml-auto flex items-center gap-2">
            {conflict.status === "OPEN" && (
              <Button size="sm" onClick={onAdjudicate}>
                <Gavel /> Adjudicate
              </Button>
            )}
            {conflict.status === "RESOLVED" && (
              <Button size="sm" variant="outline" onClick={onReopen}>
                <RotateCcw /> Reopen
              </Button>
            )}
          </div>
        </div>

        <div>
          <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            Reviewer decisions
          </p>
          {decisions.length === 0 ? (
            <Alert variant="info" className="mt-2 flex items-center gap-2">
              <EyeOff className="h-4 w-4 shrink-0" />
              <span>
                Reviewer decisions are hidden until you have adjudication rights in this
                project.
              </span>
            </Alert>
          ) : (
            <div className="mt-2 space-y-2">
              {decisions.map((d) => (
                <DecisionRow key={d.id} decision={d} />
              ))}
            </div>
          )}
        </div>

        {conflict.adjudication && (
          <AdjudicationPanel
            adjudication={conflict.adjudication}
            current={conflict.status === "RESOLVED"}
          />
        )}

        {conflict.status === "VOIDED" && (
          <Alert variant="warning">
            This conflict was voided — its stage result was reopened or the citation was
            merged as a duplicate. It reopens automatically if reviewers disagree again.
          </Alert>
        )}
      </div>
    </CitationCard>
  );
}

function DecisionRow({ decision }: { decision: ConflictDecision }) {
  return (
    <div className="rounded-md border border-border bg-background px-3 py-2">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <Badge variant={DECISION_BADGE_VARIANT[decision.decision]}>
          {decision.decision.toLowerCase()}
        </Badge>
        <span className="text-sm font-medium">{decision.reviewer?.name ?? "Reviewer"}</span>
        {decision.exclusionReason && (
          <Badge variant="outline">{decision.exclusionReason.label}</Badge>
        )}
        {decision.flaggedForDiscussion && (
          <Badge variant="outline" className="gap-1">
            <Flag className="h-3 w-3" /> discussion
          </Badge>
        )}
        {decision.labels?.map((l) => (
          <Badge key={l} variant="secondary">
            {l}
          </Badge>
        ))}
        <span className="ml-auto text-xs text-muted-foreground">
          {new Date(decision.createdAt).toLocaleString()}
        </span>
      </div>
      {decision.notes && (
        <p className="mt-1.5 whitespace-pre-line text-sm text-muted-foreground">
          {decision.notes}
        </p>
      )}
    </div>
  );
}

function AdjudicationPanel({
  adjudication,
  current,
}: {
  adjudication: ConflictAdjudication;
  current: boolean;
}) {
  return (
    <div className="rounded-md border border-border bg-muted/40 px-3 py-2.5">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <Gavel className="h-4 w-4 text-muted-foreground" />
        <span className="text-sm font-medium">
          {current ? "Adjudication" : "Previous adjudication"}
        </span>
        <Badge variant={DECISION_BADGE_VARIANT[adjudication.finalDecision]}>
          {adjudication.finalDecision.toLowerCase()}
        </Badge>
        {adjudication.exclusionReason && (
          <Badge variant="outline">{adjudication.exclusionReason.label}</Badge>
        )}
        <span className="ml-auto text-xs text-muted-foreground">
          {adjudication.adjudicator?.name ?? "Adjudicator"} ·{" "}
          {new Date(adjudication.createdAt).toLocaleString()}
        </span>
      </div>
      {!current && (
        <p className="mt-1 text-xs text-muted-foreground">
          Superseded by a reopen — re-adjudication will replace it.
        </p>
      )}
      <p className="mt-1.5 whitespace-pre-line text-sm text-muted-foreground">
        {adjudication.reason}
      </p>
    </div>
  );
}
