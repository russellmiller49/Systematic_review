"use client";

// Summary-of-findings table across every analysis outcome: pooled effect, anticipated
// absolute effects per 1,000, and GRADE certainty with numbered footnotes. Everything
// is recomputed server-side per fetch from caller-independent final-only inputs.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Papa from "papaparse";
import { Download, RefreshCw, Sigma } from "lucide-react";
import { toast } from "sonner";
import { api } from "@/lib/api";
import { formatDateTime } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { EmptyState, Skeleton, Spinner } from "@/components/ui/misc";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { CertaintyBadge } from "./certainty-badge";
import {
  apiErrorMessages,
  fmtCi,
  MEASURE_LABELS,
  MODEL_LABELS,
  sofCertaintyPresentation,
  superscriptMarker,
  type EffectMeasure,
  type SofPayload,
  type SofRow,
} from "./types";

const per1000 = (v: number) => String(Math.round(v));

// Client-added footnote explaining a "—" in the absolute column (server footnotes
// only cover certainty domains).
function absoluteNote(measure: EffectMeasure): string {
  if (measure === "MD" || measure === "SMD" || measure === "GENERIC_IV") {
    return "Per-1,000 absolute effects are not defined for this effect measure — the pooled effect is shown under Relative effect.";
  }
  return "No anticipated absolute effect could be computed (control-group risks unavailable).";
}

function needsAbsoluteNote(row: SofRow): boolean {
  return row.absolute === null && row.proportionPer1000 === null && row.relative !== null;
}

interface RowNotes {
  certaintyMarkers: string;
  absoluteMarker: string | null;
}

export function SofTable({ projectId }: { projectId: string }) {
  const [sof, setSof] = useState<SofPayload | null>(null);
  const [loading, setLoading] = useState(false);

  // Staleness guard (results-table pattern): manual refreshes and focus refetches can
  // interleave; only the latest request may apply.
  const loadSeq = useRef(0);

  const load = useCallback(
    (silent = false) => {
      const seq = ++loadSeq.current;
      const isCurrent = () => seq === loadSeq.current;
      if (!silent) setLoading(true);
      api<SofPayload>(`/api/projects/${projectId}/analysis/sof`)
        .then((data) => {
          if (isCurrent()) setSof(data);
        })
        .catch((err) => {
          if (!silent && isCurrent()) toast.error(apiErrorMessages(err).join("; "));
        })
        .finally(() => {
          if (isCurrent()) setLoading(false);
        });
    },
    [projectId],
  );

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    const onFocus = () => load(true);
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [load]);

  // Number footnotes continuously across the table; each row keeps its own markers
  // (domain notes point from the Certainty cell, the absolute note from its dash).
  const { notesByRow, footnoteList } = useMemo(() => {
    const list: string[] = [];
    const byRow = new Map<string, RowNotes>();
    for (const row of sof?.rows ?? []) {
      const markers: string[] = [];
      for (const note of row.footnotes) {
        list.push(note);
        markers.push(superscriptMarker(list.length));
      }
      let absoluteMarker: string | null = null;
      if (needsAbsoluteNote(row)) {
        list.push(absoluteNote(row.measure));
        absoluteMarker = superscriptMarker(list.length);
      }
      byRow.set(row.outcomeId, { certaintyMarkers: markers.join(""), absoluteMarker });
    }
    return { notesByRow: byRow, footnoteList: list };
  }, [sof]);

  function exportCsv() {
    if (!sof) return;
    const header = [
      "Outcome",
      "Timepoint",
      "Measure",
      "Model",
      "Studies",
      "Participants",
      "Relative effect (95% CI)",
      "Assumed per 1000",
      "Corresponding per 1000 (95% CI)",
      "Proportion per 1000 (95% CI)",
      "Certainty",
      "Points",
      "Status",
      "Footnotes",
    ];
    const data = sof.rows.map((row) => {
      const notes = [...row.footnotes];
      if (needsAbsoluteNote(row)) notes.push(absoluteNote(row.measure));
      const certainty = row.certainty ? sofCertaintyPresentation(row.certainty) : null;
      return [
        row.name,
        row.timepoint ?? "",
        MEASURE_LABELS[row.measure],
        MODEL_LABELS[row.model],
        String(row.k),
        row.totalN !== null ? String(row.totalN) : "",
        row.relative ? fmtCi(row.relative) : "",
        row.absolute ? per1000(row.absolute.assumedPer1000) : "",
        row.absolute
          ? `${per1000(row.absolute.correspondingPer1000)} (${per1000(row.absolute.correspondingCiLowPer1000)} to ${per1000(row.absolute.correspondingCiHighPer1000)})`
          : "",
        row.proportionPer1000
          ? `${per1000(row.proportionPer1000.estimate)} (${per1000(row.proportionPer1000.ciLow)} to ${per1000(row.proportionPer1000.ciHigh)})`
          : "",
        certainty?.certaintyText ?? "Not assessed",
        row.certainty ? String(row.certainty.points) : "",
        certainty?.statusText ?? "",
        notes.join(" | "),
      ];
    });
    const csv = Papa.unparse({ fields: header, data }, { escapeFormulae: true });
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "summary-of-findings.csv";
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <Card>
      <CardHeader>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <CardTitle className="text-base">Summary of findings</CardTitle>
            <CardDescription>
              GRADE summary across every analysis outcome — pooled effects, anticipated
              absolute effects, and certainty of evidence.
              {sof ? ` Generated ${formatDateTime(sof.generatedAt)}.` : ""}
            </CardDescription>
          </div>
          <div className="flex items-center gap-2">
            <Button variant="outline" size="sm" onClick={() => load()} disabled={loading}>
              {loading ? <Spinner className="h-3.5 w-3.5" /> : <RefreshCw />} Refresh
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={exportCsv}
              disabled={!sof || sof.rows.length === 0}
            >
              <Download /> Download CSV
            </Button>
          </div>
        </div>
      </CardHeader>
      <CardContent>
        {sof === null ? (
          <Skeleton className="h-64" />
        ) : sof.rows.length === 0 ? (
          <EmptyState
            icon={Sigma}
            title="No analysis outcomes yet"
            description="Define outcomes and map extraction fields — the summary of findings builds itself from the pooled results."
          />
        ) : (
          <>
            <div className="overflow-x-auto rounded-lg border border-border">
              <Table className="min-w-max">
                <TableHeader>
                  <TableRow>
                    <TableHead>Outcome</TableHead>
                    <TableHead>Studies</TableHead>
                    <TableHead>Participants</TableHead>
                    <TableHead>Relative effect (95% CI)</TableHead>
                    <TableHead>Anticipated absolute effects (per 1,000)</TableHead>
                    <TableHead>Certainty</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {sof.rows.map((row) => {
                    const notes = notesByRow.get(row.outcomeId);
                    const certainty = row.certainty
                      ? sofCertaintyPresentation(row.certainty)
                      : null;
                    return (
                      <TableRow key={row.outcomeId}>
                        <TableCell className="align-top">
                          <span className="font-medium">{row.name}</span>
                          <span className="block text-xs text-muted-foreground">
                            {MEASURE_LABELS[row.measure]}
                            {row.timepoint ? ` · ${row.timepoint}` : ""}
                          </span>
                        </TableCell>
                        <TableCell className="align-top tabular-nums">{row.k}</TableCell>
                        <TableCell className="align-top tabular-nums">
                          {row.totalN ?? "—"}
                        </TableCell>
                        <TableCell className="whitespace-nowrap align-top tabular-nums">
                          {row.relative ? (
                            <>
                              {fmtCi(row.relative)}
                              <span className="block text-xs text-muted-foreground">
                                {MODEL_LABELS[row.model]}
                              </span>
                            </>
                          ) : (
                            "—"
                          )}
                        </TableCell>
                        <TableCell className="align-top tabular-nums">
                          {row.absolute ? (
                            <>
                              <span className="block text-xs text-muted-foreground">
                                {row.groupLabels.g2}:{" "}
                                {per1000(row.absolute.assumedPer1000)} per 1,000
                              </span>
                              <span className="block whitespace-nowrap">
                                {row.groupLabels.g1}:{" "}
                                {per1000(row.absolute.correspondingPer1000)} per 1,000 (
                                {per1000(row.absolute.correspondingCiLowPer1000)} to{" "}
                                {per1000(row.absolute.correspondingCiHighPer1000)})
                              </span>
                            </>
                          ) : row.proportionPer1000 ? (
                            <span className="whitespace-nowrap">
                              {per1000(row.proportionPer1000.estimate)} per 1,000 (
                              {per1000(row.proportionPer1000.ciLow)} to{" "}
                              {per1000(row.proportionPer1000.ciHigh)})
                            </span>
                          ) : (
                            <span>
                              —{notes?.absoluteMarker ?? ""}
                            </span>
                          )}
                        </TableCell>
                        <TableCell className="align-top">
                          {row.certainty ? (
                            <div className="space-y-1">
                              <div className="flex items-center gap-1">
                                <CertaintyBadge certainty={row.certainty.level} />
                                {notes?.certaintyMarkers && (
                                  <span className="text-xs">{notes.certaintyMarkers}</span>
                                )}
                              </div>
                              <Badge
                                variant={
                                  certainty?.outOfDate
                                    ? "exclude"
                                    : row.certainty.status === "REVIEWED"
                                      ? "include"
                                      : "maybe"
                                }
                                className="px-1.5 py-0 text-[10px]"
                                title={
                                  !certainty?.outOfDate &&
                                  row.certainty.status === "REVIEWED" &&
                                  row.certainty.reviewedByName
                                    ? `Reviewed by ${row.certainty.reviewedByName}`
                                    : undefined
                                }
                              >
                                {certainty?.statusText}
                              </Badge>
                              {certainty?.detail && (
                                <p className="max-w-64 text-xs text-exclude">{certainty.detail}</p>
                              )}
                            </div>
                          ) : (
                            <span className="text-xs text-muted-foreground">
                              Not assessed{notes?.certaintyMarkers ?? ""}
                            </span>
                          )}
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </div>
            {footnoteList.length > 0 && (
              <ol className="mt-3 space-y-1 text-xs text-muted-foreground">
                {footnoteList.map((note, i) => (
                  <li key={i}>
                    {superscriptMarker(i + 1)} {note}
                  </li>
                ))}
              </ol>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}
