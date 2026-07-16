// computeMeta — the single entry point for running a meta-analysis.
//
// PURE, DETERMINISTIC TypeScript. AI has NO role in any computation here: every
// number is produced by the closed-form statistics in this directory and is
// validated against an independent Python/scipy reference implementation
// (scripts/generate-stats-fixtures.py -> __fixtures__/, checked by fixtures.test.ts).
//
// Behavior (see types.ts for the binding contract):
// - Routes binary data to binaryEffect, continuous to continuousEffect, single-arm
//   proportions to proportionEffect (logit or Freeman–Tukey), and pre-computed
//   estimates to genericEffect; a kind/measure mismatch excludes the study with a
//   reason. Never throws on bad study data.
// - Analysis scale: natural log for RR/OR; logit/double-arcsine for PROPORTION;
//   identity otherwise. `display` blocks back-transform: exp() on the log scale,
//   inverse logit, or Miller's inverse double-arcsine — per-study values with that
//   study's own n, POOLED values (and the prediction interval) with the HARMONIC MEAN
//   of the included studies' n.
// - Included studies preserve input order; percentage weights sum to ~100.
// - Random-effects prediction interval and Egger's regression test both require
//   k >= 3 included studies, else null.

import { binaryEffect } from "./effects/binary";
import { continuousEffect } from "./effects/continuous";
import { genericEffect } from "./effects/generic";
import { ftInverse, harmonicMean, invLogit, proportionEffect } from "./effects/proportion";
import { eggerTest } from "./egger";
import { qnorm } from "./normal";
import { dersimonianLaird, fixedEffect } from "./pool";
import type {
  ComputeMetaOptions,
  DisplayEstimate,
  DisplayMeta,
  EffectEstimate,
  ExcludedStudy,
  MetaResult,
  PooledEstimate,
  PredictionInterval,
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
  const transform = opts.proportionTransform ?? "LOGIT";
  const scale = scaleFor(measure, transform);

  // ---- per-study effects (input order preserved) ----
  // For FT proportions each study's display back-transform needs its own n.
  const included: { input: StudyEffectInput; estimate: EffectEstimate; n: number | null }[] = [];
  const excluded: ExcludedStudy[] = [];
  for (const study of studies) {
    let result: { estimate: EffectEstimate } | { excludedReason: string };
    let n: number | null = null;
    if (measure === "RR" || measure === "OR" || measure === "RD") {
      result =
        study.data.kind === "binary"
          ? binaryEffect(measure, study.data.counts)
          : { excludedReason: `measure ${measure} requires binary 2×2 counts` };
    } else if (measure === "MD" || measure === "SMD") {
      result =
        study.data.kind === "continuous"
          ? continuousEffect(measure, study.data.stats)
          : { excludedReason: `measure ${measure} requires continuous summary statistics` };
    } else if (measure === "PROPORTION") {
      if (study.data.kind === "proportion") {
        result = proportionEffect(transform, study.data.counts);
        n = study.data.counts.n;
      } else {
        result = { excludedReason: "measure PROPORTION requires single-arm event counts" };
      }
    } else {
      result =
        study.data.kind === "generic"
          ? genericEffect(study.data.stats)
          : { excludedReason: "measure GENERIC_IV requires a pre-computed estimate" };
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
      included.push({ input: study, estimate: result.estimate, n });
    }
  }

  // ---- display back-transforms ----
  // FT pooled values (and the PI) use the harmonic mean of the included studies' n.
  const ftPooledN =
    scale === "ft" ? harmonicMean(included.map((s) => s.n).filter((n): n is number => n !== null)) : null;
  const toDisplay = (v: number, ftN: number | null): number => {
    if (scale === "log") return Math.exp(v);
    if (scale === "logit") return invLogit(v);
    if (scale === "ft") return ftN !== null ? ftInverse(v, ftN) : v;
    return v;
  };
  const display = (y: number, ciLow: number, ciHigh: number, ftN: number | null): DisplayEstimate => ({
    estimate: toDisplay(y, ftN),
    ciLow: toDisplay(ciLow, ftN),
    ciHigh: toDisplay(ciHigh, ftN),
  });
  const displayMeta: DisplayMeta = {
    transform:
      scale === "log" ? "exp" : scale === "logit" ? "invlogit" : scale === "ft" ? "ft" : "identity",
    harmonicN: ftPooledN,
  };

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
    display: display(p.y, p.ciLow, p.ciHigh, ftPooledN),
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
      // Per-study FT back-transform uses that study's OWN n (Miller 1978).
      display: display(y, ciLow, ciHigh, scale === "ft" ? s.n : null),
      weightFixedPct: fixed!.weightsPct[i]!,
      weightRandomPct: dl!.pooled.weightsPct[i]!,
    };
  });

  const predictionInterval: PredictionInterval | null = dl?.predictionInterval
    ? {
        low: dl.predictionInterval.low,
        high: dl.predictionInterval.high,
        display: {
          low: toDisplay(dl.predictionInterval.low, ftPooledN),
          high: toDisplay(dl.predictionInterval.high, ftPooledN),
        },
      }
    : null;

  return {
    measure,
    scale,
    nullValue: nullValueFor(measure),
    studies: studyResults,
    excluded,
    fixed: fixed ? toPooled("FIXED", fixed) : null,
    random: dl ? toPooled("RANDOM", dl.pooled) : null,
    heterogeneity: dl ? dl.heterogeneity : null,
    predictionInterval,
    egger: eggerTest(estimates),
    displayMeta,
  };
}
