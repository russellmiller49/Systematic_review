// computeMeta — the single entry point for running a meta-analysis.
//
// PURE, DETERMINISTIC TypeScript. AI has NO role in any computation here: every
// number is produced by the closed-form statistics in this directory and is
// validated against an independent Python/scipy reference implementation
// (scripts/generate-stats-fixtures.py -> __fixtures__/, checked by fixtures.test.ts).
//
// Behavior (see types.ts for the binding contract):
// - Routes binary data to binaryEffect and continuous data to continuousEffect;
//   a kind/measure mismatch excludes the study with a reason. Never throws on
//   bad study data.
// - Analysis scale is natural log for RR/OR, identity otherwise; `display`
//   blocks are back-transformed via exp() on the log scale.
// - Included studies preserve input order; percentage weights sum to ~100.

import { binaryEffect } from "./effects/binary";
import { continuousEffect } from "./effects/continuous";
import { qnorm } from "./normal";
import { dersimonianLaird, fixedEffect } from "./pool";
import type {
  ComputeMetaOptions,
  DisplayEstimate,
  EffectEstimate,
  ExcludedStudy,
  MetaResult,
  PooledEstimate,
  StudyEffectInput,
  StudyEffectResult,
} from "./types";
import { nullValueFor, scaleFor } from "./types";

// A study can only enter inverse-variance pooling if its weight w = 1/se² is a
// finite positive number; extreme (but individually valid) standard errors make
// w overflow to Infinity or underflow to 0, either of which poisons pooled sums.
function isWeightable(se: number): boolean {
  const w = 1 / (se * se);
  return Number.isFinite(w) && w > 0;
}

export function computeMeta(
  studies: StudyEffectInput[],
  opts: ComputeMetaOptions,
): MetaResult {
  const { measure } = opts;
  const scale = scaleFor(measure);
  const toDisplay = (v: number): number => (scale === "log" ? Math.exp(v) : v);
  const display = (y: number, ciLow: number, ciHigh: number): DisplayEstimate => ({
    estimate: toDisplay(y),
    ciLow: toDisplay(ciLow),
    ciHigh: toDisplay(ciHigh),
  });

  // ---- per-study effects (input order preserved) ----
  const included: { input: StudyEffectInput; estimate: EffectEstimate }[] = [];
  const excluded: ExcludedStudy[] = [];
  for (const study of studies) {
    let result: { estimate: EffectEstimate } | { excludedReason: string };
    if (measure === "RR" || measure === "OR" || measure === "RD") {
      result =
        study.data.kind === "binary"
          ? binaryEffect(measure, study.data.counts)
          : { excludedReason: `measure ${measure} requires binary 2×2 counts` };
    } else {
      result =
        study.data.kind === "continuous"
          ? continuousEffect(measure, study.data.stats)
          : { excludedReason: `measure ${measure} requires continuous summary statistics` };
    }
    if ("excludedReason" in result) {
      excluded.push({ id: study.id, label: study.label, reason: result.excludedReason });
    } else if (!isWeightable(result.estimate.se)) {
      // Inverse-variance pooling needs a finite positive weight w = 1/se².
      // A valid but extreme se (e.g. < ~1e-154 or > ~1.3e154) makes w overflow
      // to Infinity or underflow to 0, which would poison the pooled sums with
      // NaN in pool.ts — exclude such studies here per the never-NaN contract.
      excluded.push({
        id: study.id,
        label: study.label,
        reason: "standard error too extreme to weight (inverse-variance weight overflows)",
      });
    } else {
      included.push({ input: study, estimate: result.estimate });
    }
  }

  // ---- pooling ----
  const estimates = included.map((s) => s.estimate);
  const fixed = fixedEffect(estimates);
  const dl = dersimonianLaird(estimates);
  const toPooled = (
    model: "FIXED" | "RANDOM",
    p: NonNullable<typeof fixed>,
  ): PooledEstimate => ({
    model,
    y: p.y,
    se: p.se,
    ciLow: p.ciLow,
    ciHigh: p.ciHigh,
    display: display(p.y, p.ciLow, p.ciHigh),
    z: p.z,
    p: p.p,
  });

  // Per-study CIs use the same normal quantile as the pooled CIs; the pooled
  // results carry the per-model percentage weights aligned to `included`.
  const z975 = qnorm(0.975);
  const studyResults: StudyEffectResult[] = included.map((s, i) => {
    const { y, se } = s.estimate;
    const ciLow = y - z975 * se;
    const ciHigh = y + z975 * se;
    return {
      id: s.input.id,
      label: s.input.label,
      y,
      se,
      ciLow,
      ciHigh,
      display: display(y, ciLow, ciHigh),
      weightFixedPct: fixed!.weightsPct[i]!,
      weightRandomPct: dl!.pooled.weightsPct[i]!,
    };
  });

  return {
    measure,
    scale,
    nullValue: nullValueFor(measure),
    studies: studyResults,
    excluded,
    fixed: fixed ? toPooled("FIXED", fixed) : null,
    random: dl ? toPooled("RANDOM", dl.pooled) : null,
    heterogeneity: dl ? dl.heterogeneity : null,
  };
}
