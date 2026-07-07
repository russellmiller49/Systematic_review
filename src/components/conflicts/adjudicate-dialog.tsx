"use client";

import { useEffect, useState } from "react";
import { CheckCircle2, Gavel, XCircle } from "lucide-react";
import { toast } from "sonner";
import { api, apiPost, ApiError } from "@/lib/api";
import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { Alert, Skeleton, Spinner } from "@/components/ui/misc";
import { formatAuthors } from "@/components/citations/citation-card";
import {
  DECISION_BADGE_VARIANT,
  STAGE_LABELS,
  type ConflictRow,
  type EligibilityCriterion,
  type ExclusionReasonOption,
} from "@/components/conflicts/types";

type FinalDecision = "INCLUDE" | "EXCLUDE";

export function AdjudicateDialog({
  projectId,
  conflict,
  criteria,
  onClose,
  onDone,
}: {
  projectId: string;
  conflict: ConflictRow;
  criteria: EligibilityCriterion[];
  onClose: () => void;
  onDone: () => void;
}) {
  const stageType = conflict.stage.type;
  const [finalDecision, setFinalDecision] = useState<FinalDecision | null>(null);
  const [exclusionReasonId, setExclusionReasonId] = useState("");
  const [rationale, setRationale] = useState("");
  const [reasons, setReasons] = useState<ExclusionReasonOption[] | null>(null);
  const [busy, setBusy] = useState(false);

  // Reasons applicable at this conflict's stage (stage-specific + BOTH).
  useEffect(() => {
    api<ExclusionReasonOption[]>(
      `/api/projects/${projectId}/exclusion-reasons?stage=${stageType}`,
    )
      .then(setReasons)
      .catch(() => {
        setReasons([]);
        toast.error("Failed to load exclusion reasons");
      });
  }, [projectId, stageType]);

  const decisions = conflict.decisions ?? [];
  const inclusion = criteria.filter((c) => c.type === "INCLUSION");
  const exclusion = criteria.filter((c) => c.type === "EXCLUSION");

  // FULL_TEXT exclusions require a reason (adjudicateSchema + service rule).
  const reasonRequired = finalDecision === "EXCLUDE" && stageType === "FULL_TEXT";
  const noFtReasons = reasonRequired && reasons !== null && reasons.length === 0;
  const canSubmit =
    finalDecision !== null &&
    rationale.trim().length >= 3 &&
    (!reasonRequired || exclusionReasonId !== "") &&
    !busy;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!finalDecision) return;
    setBusy(true);
    try {
      await apiPost(`/api/projects/${projectId}/conflicts/${conflict.id}/adjudicate`, {
        finalDecision,
        exclusionReasonId:
          finalDecision === "EXCLUDE" && exclusionReasonId ? exclusionReasonId : null,
        reason: rationale.trim(),
      });
      toast.success(`Conflict resolved — final decision: ${finalDecision.toLowerCase()}`);
      onDone();
    } catch (err) {
      if (err instanceof ApiError && err.status === 403) {
        toast.error("You do not have permission to adjudicate conflicts in this project");
      } else {
        toast.error(err instanceof ApiError ? err.message : "Failed to adjudicate conflict");
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-h-[85vh] max-w-2xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Adjudicate conflict — {STAGE_LABELS[stageType]}</DialogTitle>
          <DialogDescription>
            Record the final screening decision for this citation. Reviewer decisions are
            never modified by adjudication.
          </DialogDescription>
        </DialogHeader>

        <div className="rounded-md border border-border bg-muted/30 px-3 py-2.5">
          <p className="text-sm font-medium leading-snug">{conflict.citation.title}</p>
          <p className="mt-0.5 text-xs text-muted-foreground">
            {formatAuthors(conflict.citation.authors)}
            {conflict.citation.journal && ` · ${conflict.citation.journal}`}
            {conflict.citation.year && ` · ${conflict.citation.year}`}
          </p>
        </div>

        {decisions.length > 0 && (
          <div className="space-y-1.5">
            <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
              Competing decisions
            </p>
            <div className="max-h-40 space-y-1.5 overflow-y-auto">
              {decisions.map((d) => (
                <div
                  key={d.id}
                  className="rounded-md border border-border px-2.5 py-1.5 text-sm"
                >
                  <div className="flex flex-wrap items-center gap-1.5">
                    <Badge variant={DECISION_BADGE_VARIANT[d.decision]}>
                      {d.decision.toLowerCase()}
                    </Badge>
                    <span className="font-medium">{d.reviewer?.name ?? "Reviewer"}</span>
                    {d.exclusionReason && (
                      <span className="text-xs text-muted-foreground">
                        {d.exclusionReason.label}
                      </span>
                    )}
                  </div>
                  {d.notes && (
                    <p className="mt-1 line-clamp-2 text-xs text-muted-foreground">
                      {d.notes}
                    </p>
                  )}
                </div>
              ))}
            </div>
          </div>
        )}

        {criteria.length > 0 && (
          <details className="rounded-md border border-border px-3 py-2">
            <summary className="cursor-pointer text-sm font-medium">
              Eligibility criteria
            </summary>
            <div className="mt-2 space-y-3">
              <CriteriaGroup label="Inclusion" items={inclusion} />
              <CriteriaGroup label="Exclusion" items={exclusion} />
            </div>
          </details>
        )}

        <form onSubmit={submit} className="space-y-4">
          <fieldset className="space-y-1.5">
            <legend className="text-sm font-medium leading-none">Final decision</legend>
            <div className="mt-1.5 grid grid-cols-2 gap-2">
              <DecisionRadio
                value="INCLUDE"
                selected={finalDecision === "INCLUDE"}
                onSelect={() => setFinalDecision("INCLUDE")}
              />
              <DecisionRadio
                value="EXCLUDE"
                selected={finalDecision === "EXCLUDE"}
                onSelect={() => setFinalDecision("EXCLUDE")}
              />
            </div>
            <p className="text-xs text-muted-foreground">
              Adjudication must be decisive — maybe is not available.
            </p>
          </fieldset>

          {finalDecision === "EXCLUDE" && (
            <div className="space-y-1.5">
              <Label htmlFor="adj-exclusion-reason">
                Exclusion reason{stageType === "FULL_TEXT" ? " (required)" : " (optional)"}
              </Label>
              {reasons === null ? (
                <Skeleton className="h-9" />
              ) : noFtReasons ? (
                <Alert variant="warning">
                  No active full-text exclusion reasons are defined for this project. Add
                  reasons in the protocol before excluding at full text.
                </Alert>
              ) : (
                <Select
                  id="adj-exclusion-reason"
                  value={exclusionReasonId}
                  onChange={(e) => setExclusionReasonId(e.target.value)}
                >
                  <option value="">
                    {stageType === "FULL_TEXT" ? "Select a reason…" : "No specific reason"}
                  </option>
                  {reasons.map((r) => (
                    <option key={r.id} value={r.id}>
                      {r.label}
                    </option>
                  ))}
                </Select>
              )}
            </div>
          )}

          <div className="space-y-1.5">
            <Label htmlFor="adj-rationale">Rationale (required)</Label>
            <Textarea
              id="adj-rationale"
              required
              minLength={3}
              value={rationale}
              onChange={(e) => setRationale(e.target.value)}
              placeholder="Why this decision resolves the disagreement…"
            />
          </div>

          <DialogFooter>
            <DialogClose asChild>
              <Button variant="outline" disabled={busy}>
                Cancel
              </Button>
            </DialogClose>
            <Button
              type="submit"
              variant={
                finalDecision === "INCLUDE"
                  ? "include"
                  : finalDecision === "EXCLUDE"
                    ? "exclude"
                    : "default"
              }
              disabled={!canSubmit}
            >
              {busy ? <Spinner /> : <Gavel />} Record decision
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function DecisionRadio({
  value,
  selected,
  onSelect,
}: {
  value: FinalDecision;
  selected: boolean;
  onSelect: () => void;
}) {
  const Icon = value === "INCLUDE" ? CheckCircle2 : XCircle;
  return (
    <label
      className={cn(
        "flex cursor-pointer items-center justify-center gap-2 rounded-md border px-3 py-2 text-sm font-medium transition-colors",
        selected
          ? value === "INCLUDE"
            ? "border-include bg-include-muted text-include"
            : "border-exclude bg-exclude-muted text-exclude"
          : "border-border text-foreground hover:bg-muted",
      )}
    >
      <input
        type="radio"
        name="final-decision"
        className="sr-only"
        value={value}
        checked={selected}
        onChange={onSelect}
      />
      <Icon className="h-4 w-4" />
      {value === "INCLUDE" ? "Include" : "Exclude"}
    </label>
  );
}

function CriteriaGroup({
  label,
  items,
}: {
  label: string;
  items: EligibilityCriterion[];
}) {
  if (items.length === 0) return null;
  return (
    <div>
      <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
        {label}
      </p>
      <ul className="mt-1 list-disc space-y-0.5 pl-5 text-sm">
        {items.map((c) => (
          <li key={c.id}>
            {c.category && <span className="text-muted-foreground">[{c.category}] </span>}
            {c.text}
          </li>
        ))}
      </ul>
    </div>
  );
}
