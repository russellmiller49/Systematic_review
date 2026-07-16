"use client";

// Live results for the selected analysis outcome: per-study resolved values with
// provenance chips, pooled fixed/random estimates + heterogeneity, and the forest
// plot. Nothing is stored server-side — every fetch recomputes from current
// extraction data, so this section polls while visible to stay "live".

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { RefreshCw, Undo2, XCircle } from "lucide-react";
import { toast } from "sonner";
import { api, apiPut } from "@/lib/api";
import { cn } from "@/lib/utils";
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
import { EmptyState, Skeleton, Spinner } from "@/components/ui/misc";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Textarea } from "@/components/ui/textarea";
import { ForestPlot } from "./forest-plot";
import type { ForestPlotInput, ForestPlotRow } from "./forest-plot-layout";
import { FunnelPlot } from "./funnel-plot";
import type { FunnelPlotInput } from "./funnel-plot-layout";
import {
  fmtCi,
  fmtEstimate,
  fmtP,
  fmtValue,
  isBinaryMeasure,
  isContinuousMeasure,
  MEASURE_LABELS,
  MODEL_LABELS,
  resolveGroupLabels,
  ROW_STATUS_META,
  roleLabel,
  slugify,
  SOURCE_BADGE,
  type AnalysisOutcomeRow,
  type AnalysisResultRow,
  type AnalysisResults,
  type PoolingModel,
} from "./types";

// A row is pooled when the stats engine produced an effect for it.
function isPooled(row: AnalysisResultRow): boolean {
  return row.status === "included" || row.status === "provisional";
}

const SCALE_LABELS: Record<string, string> = {
  log: "log",
  linear: "linear",
  logit: "logit",
  ft: "double-arcsine",
};

// Per-measure data columns for the forest plot (headers + one cell per pooled row).
function plotDataColumns(
  results: AnalysisResults,
): { headers: string[]; cols: (row: AnalysisResultRow) => string[] } {
  const measure = results.outcome.measure;
  const { g1, g2 } = results.groupLabels;
  const v = (row: AnalysisResultRow, role: string) => fmtValue(row.values[role]?.value ?? null);
  if (isBinaryMeasure(measure)) {
    return {
      headers: [g1, g2],
      cols: (row) => [
        `${v(row, "G1_EVENTS")}/${v(row, "G1_TOTAL")}`,
        `${v(row, "G2_EVENTS")}/${v(row, "G2_TOTAL")}`,
      ],
    };
  }
  if (isContinuousMeasure(measure)) {
    return {
      headers: [g1, g2],
      cols: (row) => [
        `${v(row, "G1_MEAN")} (${v(row, "G1_SD")}), ${v(row, "G1_N")}`,
        `${v(row, "G2_MEAN")} (${v(row, "G2_SD")}), ${v(row, "G2_N")}`,
      ],
    };
  }
  if (measure === "PROPORTION") {
    // Single arm: one events/total column labeled with the cohort (g1) label.
    return { headers: [g1], cols: (row) => [`${v(row, "G1_EVENTS")}/${v(row, "G1_TOTAL")}`] };
  }
  // GENERIC_IV: the SE actually used for pooling (possibly CI-derived, so read the effect).
  return { headers: ["SE"], cols: (row) => [row.effect ? fmtEstimate(row.effect.se) : "—"] };
}

// Assemble the forest-plot input (pinned contract in ./forest-plot-layout) from the
// results payload: pooled rows become plot rows, everything else lands in `excluded`.
function buildPlotInput(results: AnalysisResults, model: PoolingModel): ForestPlotInput {
  const outcome = results.outcome;
  const { g1, g2 } = results.groupLabels;
  const proportion = outcome.measure === "PROPORTION";
  const { headers, cols } = plotDataColumns(results);

  const rows: ForestPlotRow[] = [];
  for (const row of results.rows) {
    if (!isPooled(row) || row.effect === null) continue;
    rows.push({
      label: row.label,
      estimate: row.effect.display.estimate,
      ciLow: row.effect.display.ciLow,
      ciHigh: row.effect.display.ciHigh,
      weightPct: model === "FIXED" ? row.effect.weightFixedPct : row.effect.weightRandomPct,
      dataCols: cols(row),
      provisional: row.status === "provisional",
    });
  }

  const excluded = results.rows
    .filter((row) => !isPooled(row))
    .map((row) => ({
      label: row.label,
      reason: row.reason ?? ROW_STATUS_META[row.status].fallbackReason,
    }));

  const pooledEst = model === "FIXED" ? results.pooled.fixed : results.pooled.random;

  return {
    title: outcome.timepoint ? `${outcome.name} (${outcome.timepoint})` : outcome.name,
    measureLabel: `${MEASURE_LABELS[outcome.measure]} (${outcome.measure})`,
    // Proportion scales ("logit"/"ft") plot their display proportions on a linear axis;
    // log stays log-positioned. The forest plot renders DISPLAY values either way.
    scale: results.scale === "log" ? "log" : "linear",
    nullValue: results.nullValue, // null for PROPORTION -> the null line is omitted
    // The null-line side that favours g1 depends on the outcome direction: when lower
    // is better (e.g. mortality), effects below the null favour the intervention (g1).
    // A single-arm proportion has no comparator, so no favours labels.
    favours: proportion
      ? undefined
      : outcome.direction === "HIGHER_IS_BETTER"
        ? { left: `Favours ${g2}`, right: `Favours ${g1}` }
        : { left: `Favours ${g1}`, right: `Favours ${g2}` },
    columnHeaders: headers,
    rows,
    pooled: pooledEst
      ? {
          label: MODEL_LABELS[model],
          estimate: pooledEst.display.estimate,
          ciLow: pooledEst.display.ciLow,
          ciHigh: pooledEst.display.ciHigh,
        }
      : null,
    heterogeneity: results.heterogeneity,
    excluded,
  };
}

// Funnel input: per-study effects on the ANALYSIS scale, the chosen model's pooled
// estimate, and the Egger result (all straight from the results payload).
function buildFunnelInput(results: AnalysisResults, model: PoolingModel): FunnelPlotInput {
  const outcome = results.outcome;
  const pooledEst = model === "FIXED" ? results.pooled.fixed : results.pooled.random;
  return {
    title: `${outcome.timepoint ? `${outcome.name} (${outcome.timepoint})` : outcome.name} — funnel`,
    measureLabel: `${MEASURE_LABELS[outcome.measure]} (${outcome.measure})`,
    scale: results.scale,
    harmonicN: results.displayMeta?.harmonicN ?? null,
    points: results.rows
      .filter((row) => row.effect !== null)
      .map((row) => ({ label: row.label, y: row.effect!.y, se: row.effect!.se })),
    pooledY: pooledEst?.y ?? null,
    egger: results.egger,
  };
}

export function ResultsSection({
  projectId,
  outcome,
  canManage,
}: {
  projectId: string;
  outcome: AnalysisOutcomeRow;
  canManage: boolean;
}) {
  const [results, setResults] = useState<AnalysisResults | null>(null);
  const [loading, setLoading] = useState(false);
  const [includeProvisional, setIncludeProvisional] = useState(false);
  const [model, setModel] = useState<PoolingModel>(outcome.model);
  const [excluding, setExcluding] = useState<{ studyId: string; label: string } | null>(null);
  const [excludeReason, setExcludeReason] = useState("");
  const [excludeBusy, setExcludeBusy] = useState(false);

  // Switching outcomes resets the view to that outcome's default model, no stale data.
  // Keyed on primitives so a mere refetch of the same outcome keeps the local toggle.
  const outcomeId = outcome.id;
  const defaultModel = outcome.model;
  useEffect(() => {
    setResults(null);
    setModel(defaultModel);
  }, [outcomeId, defaultModel]);

  // Request generation counter: this section stays mounted across outcome switches,
  // so a slow response for a previous (outcome, provisional) request could otherwise
  // land late and overwrite the current outcome's results. Every load() bumps the
  // sequence; a response only applies if it is still the latest request.
  const loadSeq = useRef(0);

  const load = useCallback(
    (silent = false) => {
      const seq = ++loadSeq.current;
      const isCurrent = () => seq === loadSeq.current;
      if (!silent) setLoading(true);
      api<AnalysisResults>(
        `/api/projects/${projectId}/analysis/outcomes/${outcome.id}/results${
          includeProvisional ? "?provisional=1" : ""
        }`,
      )
        .then((data) => {
          if (!isCurrent()) return;
          setResults(data);
          // The server ignores ?provisional=1 for callers who may not see provisional
          // data — drop a stale local toggle so we stop asking (and hide the checkbox).
          if (!data.provisionalAllowed) setIncludeProvisional(false);
        })
        .catch((err) => {
          // Background polls fail quietly (keep the last good data); user-driven loads toast.
          if (!silent && isCurrent()) {
            toast.error(err instanceof Error ? err.message : "Failed to load results");
          }
        })
        .finally(() => {
          // Only the latest request settles the loading flag (also clears a flag left
          // behind by a superseded user-driven load).
          if (isCurrent()) setLoading(false);
        });
    },
    // `outcome` (not just its id) so a mapping save from the parent triggers a refetch.
    [projectId, outcome, includeProvisional],
  );

  useEffect(() => {
    load();
  }, [load]);

  // The "live" forest plot: refetch on focus and every 10s while the tab is visible.
  useEffect(() => {
    const onFocus = () => load(true);
    window.addEventListener("focus", onFocus);
    const interval = window.setInterval(() => {
      if (document.visibilityState === "visible") load(true);
    }, 10_000);
    return () => {
      window.removeEventListener("focus", onFocus);
      window.clearInterval(interval);
    };
  }, [load]);

  async function submitExclude() {
    if (!excluding) return;
    const reason = excludeReason.trim();
    if (!reason) {
      toast.error("A reason is required to exclude a study");
      return;
    }
    setExcludeBusy(true);
    try {
      await apiPut(
        `/api/projects/${projectId}/analysis/outcomes/${outcome.id}/exclusions/${excluding.studyId}`,
        { excluded: true, reason },
      );
      toast.success(`${excluding.label} excluded from this outcome`);
      setExcluding(null);
      setExcludeReason("");
      load(true);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to exclude study");
    } finally {
      setExcludeBusy(false);
    }
  }

  async function reinclude(row: AnalysisResultRow) {
    try {
      await apiPut(
        `/api/projects/${projectId}/analysis/outcomes/${outcome.id}/exclusions/${row.studyId}`,
        { excluded: false },
      );
      toast.success(`${row.label} re-included`);
      load(true);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to re-include study");
    }
  }

  const plotInput = useMemo(
    () => (results ? buildPlotInput(results, model) : null),
    [results, model],
  );
  const funnelInput = useMemo(
    () => (results ? buildFunnelInput(results, model) : null),
    [results, model],
  );

  const requiredRoles = results?.outcome.requiredRoles ?? outcome.requiredRoles;
  const groups = results?.groupLabels ?? resolveGroupLabels(outcome.groupLabels, outcome.measure);

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Study data &amp; pooled effects</CardTitle>
          <CardDescription>
            Values resolve adjudicated &gt; consensus &gt; single from extraction; results refresh
            automatically while this page is open.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex flex-wrap items-center gap-3">
            <div
              className="inline-flex overflow-hidden rounded-md border border-border"
              role="group"
              aria-label="Pooling model"
            >
              {(["FIXED", "RANDOM"] as const).map((m) => (
                <button
                  key={m}
                  type="button"
                  onClick={() => setModel(m)}
                  className={cn(
                    "px-3 py-1.5 text-xs font-medium transition-colors",
                    model === m
                      ? "bg-primary text-primary-foreground"
                      : "bg-background text-muted-foreground hover:bg-muted",
                  )}
                >
                  {m === "FIXED" ? "Fixed" : "Random"}
                </button>
              ))}
            </div>
            {(results === null || results.provisionalAllowed) && (
              <Label className="flex cursor-pointer items-center gap-2 text-sm font-normal">
                <input
                  type="checkbox"
                  className="h-4 w-4 accent-primary"
                  checked={includeProvisional}
                  onChange={(e) => setIncludeProvisional(e.target.checked)}
                />
                Include provisional values
              </Label>
            )}
            <div className="flex-1" />
            <Button variant="outline" size="sm" onClick={() => load()} disabled={loading}>
              {loading ? <Spinner className="h-3.5 w-3.5" /> : <RefreshCw />} Refresh
            </Button>
          </div>

          {results === null ? (
            <Skeleton className="h-48" />
          ) : results.rows.length === 0 ? (
            <EmptyState
              title="No studies yet"
              description="Studies appear here once full-text inclusions create them and the mapped fields are extracted."
            />
          ) : (
            <div className="overflow-x-auto rounded-lg border border-border">
              <Table className="min-w-max">
                <TableHeader>
                  <TableRow>
                    <TableHead>Study</TableHead>
                    {requiredRoles.map((role) => (
                      <TableHead key={role} className="whitespace-nowrap">
                        {roleLabel(role, groups)}
                      </TableHead>
                    ))}
                    <TableHead className="whitespace-nowrap">
                      {outcome.measure} [95% CI]
                    </TableHead>
                    <TableHead>Weight</TableHead>
                    <TableHead>Status</TableHead>
                    {canManage && (
                      <TableHead className="w-28">
                        <span className="sr-only">Actions</span>
                      </TableHead>
                    )}
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {results.rows.map((row) => {
                    const meta = ROW_STATUS_META[row.status];
                    const pooled = isPooled(row);
                    const weight = row.effect
                      ? model === "FIXED"
                        ? row.effect.weightFixedPct
                        : row.effect.weightRandomPct
                      : null;
                    // Flag rows where the study-level synthesis flag and the actual pooling
                    // outcome disagree — usually a mapping gap or a stale study flag.
                    const mismatchHint =
                      row.inQuantitativeSynthesis && !pooled
                        ? "Marked for quantitative synthesis but not pooled here."
                        : !row.inQuantitativeSynthesis && pooled
                          ? "Pooled here but not marked for quantitative synthesis."
                          : null;
                    return (
                      <TableRow key={row.studyId}>
                        <TableCell className="align-top font-medium">
                          <span className="whitespace-nowrap">{row.label}</span>
                          {mismatchHint && (
                            <span className="mt-0.5 block max-w-52 text-xs font-normal text-muted-foreground">
                              {mismatchHint}
                            </span>
                          )}
                        </TableCell>
                        {requiredRoles.map((role) => {
                          const rv = row.values[role];
                          const badge = rv?.source ? SOURCE_BADGE[rv.source] : null;
                          return (
                            <TableCell key={role} className="align-top">
                              <span className="tabular-nums">{fmtValue(rv?.value ?? null)}</span>
                              {badge && (
                                <Badge
                                  variant={badge.variant}
                                  className="ml-1.5 px-1 py-0 text-[10px]"
                                >
                                  {badge.label}
                                </Badge>
                              )}
                            </TableCell>
                          );
                        })}
                        <TableCell className="whitespace-nowrap align-top tabular-nums">
                          {row.effect ? fmtCi(row.effect.display) : "—"}
                        </TableCell>
                        <TableCell className="align-top tabular-nums">
                          {weight !== null ? `${weight.toFixed(1)}%` : "—"}
                        </TableCell>
                        <TableCell className="align-top">
                          <Badge variant={meta.variant}>{meta.label}</Badge>
                          {!pooled && (
                            <span className="mt-0.5 block max-w-56 text-xs text-muted-foreground">
                              {row.reason ?? meta.fallbackReason}
                            </span>
                          )}
                        </TableCell>
                        {canManage && (
                          <TableCell className="align-top">
                            {row.status === "excluded" ? (
                              <Button
                                variant="ghost"
                                size="sm"
                                className="h-7 px-2 text-xs"
                                onClick={() => void reinclude(row)}
                              >
                                <Undo2 className="h-3.5 w-3.5" /> Re-include
                              </Button>
                            ) : (
                              <Button
                                variant="ghost"
                                size="sm"
                                className="h-7 px-2 text-xs"
                                onClick={() => {
                                  setExcludeReason("");
                                  setExcluding({ studyId: row.studyId, label: row.label });
                                }}
                              >
                                <XCircle className="h-3.5 w-3.5" /> Exclude
                              </Button>
                            )}
                          </TableCell>
                        )}
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </div>
          )}

          {results && (
            <div className="space-y-1 rounded-md border border-border bg-muted/30 p-3 text-sm">
              {(["FIXED", "RANDOM"] as const).map((m) => {
                const est = m === "FIXED" ? results.pooled.fixed : results.pooled.random;
                return (
                  <p
                    key={m}
                    className={cn(
                      "tabular-nums",
                      model === m ? "font-medium" : "text-muted-foreground",
                    )}
                  >
                    {MODEL_LABELS[m]}:{" "}
                    {est ? `${fmtCi(est.display)} — z=${est.z.toFixed(2)}, p=${fmtP(est.p)}` : "not estimable"}
                  </p>
                );
              })}
              {results.predictionInterval && (
                <p className="tabular-nums text-muted-foreground">
                  95% PI: {fmtEstimate(results.predictionInterval.display.low)} to{" "}
                  {fmtEstimate(results.predictionInterval.display.high)}
                </p>
              )}
              {results.heterogeneity && (
                <p className="text-xs tabular-nums text-muted-foreground">
                  Heterogeneity: Q={results.heterogeneity.q.toFixed(2)}, df=
                  {results.heterogeneity.df}, p={fmtP(results.heterogeneity.p)}; I²=
                  {results.heterogeneity.i2.toFixed(1)}%; τ²={results.heterogeneity.tau2.toFixed(3)}
                </p>
              )}
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Forest plot</CardTitle>
          <CardDescription>
            {model === "FIXED" ? "Fixed-effect" : "Random-effects"} weights on the{" "}
            {SCALE_LABELS[results?.scale ?? "linear"]} scale.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {plotInput === null ? (
            <Skeleton className="h-48" />
          ) : plotInput.rows.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              Nothing pooled yet — the plot draws itself as soon as at least one study has all
              required values.
            </p>
          ) : (
            <ForestPlot input={plotInput} filenameBase={slugify(outcome.name)} />
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Funnel plot</CardTitle>
          <CardDescription>
            Small-study effects diagnostics on the analysis scale —{" "}
            {results?.egger ? (
              <span className="tabular-nums">
                Egger&apos;s test: intercept {results.egger.intercept.toFixed(2)} (p ={" "}
                {fmtP(results.egger.p)}){results.egger.k < 10 ? " — k < 10, low power" : ""}
              </span>
            ) : (funnelInput?.points.length ?? 0) < 3 ? (
              "Egger's test requires at least 3 pooled studies"
            ) : (
              // Degenerate k >= 3 fit: identical precisions make the intercept unidentifiable.
              "Egger's test not estimable (studies have identical precision)"
            )}
            .
          </CardDescription>
        </CardHeader>
        <CardContent>
          {funnelInput === null ? (
            <Skeleton className="h-48" />
          ) : funnelInput.points.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              Nothing pooled yet — the funnel appears alongside the forest plot.
            </p>
          ) : (
            <FunnelPlot input={funnelInput} filenameBase={`${slugify(outcome.name)}-funnel`} />
          )}
        </CardContent>
      </Card>

      <Dialog
        open={excluding !== null}
        onOpenChange={(open) => {
          if (!open) setExcluding(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Exclude {excluding?.label}?</DialogTitle>
            <DialogDescription>
              The study is dropped from this outcome&apos;s pooling only (a sensitivity valve).
              The exclusion and its reason are recorded in the audit log.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-1.5">
            <Label htmlFor="exclude-reason">Reason</Label>
            <Textarea
              id="exclude-reason"
              rows={3}
              value={excludeReason}
              onChange={(e) => setExcludeReason(e.target.value)}
              placeholder="e.g. Zero-event outlier driving heterogeneity"
            />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setExcluding(null)} disabled={excludeBusy}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={() => void submitExclude()}
              disabled={excludeBusy || excludeReason.trim().length === 0}
            >
              {excludeBusy && <Spinner />} Exclude study
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
