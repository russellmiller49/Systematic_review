// Deterministic GRADE domain rules — Tier 1 of the GRADE pipeline.
//
// draftGradeRatings turns a pooled outcome's numbers into five DomainDrafts plus the
// certainty arithmetic. Judgment bands (thresholds exported so tests and rationale
// prose share one source of truth):
// - INCONSISTENCY: k < 2 not assessable; I² < 40 not serious, 40–75 serious, > 75 very serious.
// - IMPRECISION: strikes for null-crossing CI and short optimal information size (OIS 400);
//   a CI spanning both appreciable-effect bounds is very serious outright.
// - RISK_OF_BIAS: weight-weighted roll-up of per-study buckets.
// - INDIRECTNESS: never automated — PICO applicability is a human judgment.
// - PUBLICATION_BIAS: Egger's p at k >= 10 only.
// Every rationale quotes the numbers it used. Metrics snapshot inputs via round4() for
// live-recomputation comparisons; effect-scale prose separately mirrors the UI precision.

import type {
  DomainDraft,
  GradeCertaintyId,
  GradeDraft,
  GradeJudgmentId,
  GradeRulesInput,
  RobBucket,
} from "./types";

// INCONSISTENCY bands (I² percent).
export const I2_SERIOUS_THRESHOLD = 40; // 40 <= I² <= 75 -> SERIOUS
export const I2_VERY_SERIOUS_THRESHOLD = 75; // I² > 75 -> VERY_SERIOUS

// IMPRECISION: optimal information size heuristic (total participants) and
// appreciable-effect bounds on the display scale.
export const OIS_THRESHOLD = 400;
export const RATIO_APPRECIABLE_LOW = 0.75; // RR/OR
export const RATIO_APPRECIABLE_HIGH = 1.25;
export const SMD_APPRECIABLE_BOUND = 0.5; // SMD: ±0.5

// RISK_OF_BIAS weight thresholds (percent of pooled weight).
export const ROB_VERY_SERIOUS_HIGH_WEIGHT = 50;
export const ROB_SERIOUS_HIGH_WEIGHT = 20;
export const ROB_SERIOUS_CONCERN_WEIGHT = 50; // high + moderate + unclear + unassessed

// PUBLICATION_BIAS: minimum k for funnel-based tests, Egger p cut-off.
export const PUBLICATION_BIAS_MIN_K = 10;
export const EGGER_P_THRESHOLD = 0.1;

/** Round to 4 decimal places — shared by metrics snapshots and non-effect rationale values. */
export function round4(x: number): number {
  return Math.round(x * 1e4) / 1e4;
}

function requireFinite(value: number, path: string): void {
  if (!Number.isFinite(value)) {
    throw new Error(`draftGradeRatings: ${path} must be finite`);
  }
}

function validateFiniteInputs(
  input: GradeRulesInput,
  pooled: NonNullable<GradeRulesInput["pooled"]>,
): void {
  requireFinite(input.k, "k");
  if (input.nullValue !== null) requireFinite(input.nullValue, "nullValue");
  if (input.totalN !== null) requireFinite(input.totalN, "totalN");
  requireFinite(pooled.estimate, "pooled.estimate");
  requireFinite(pooled.ciLow, "pooled.ciLow");
  requireFinite(pooled.ciHigh, "pooled.ciHigh");
  if (input.heterogeneity !== null) {
    requireFinite(input.heterogeneity.i2, "heterogeneity.i2");
    requireFinite(input.heterogeneity.q, "heterogeneity.q");
    requireFinite(input.heterogeneity.df, "heterogeneity.df");
    requireFinite(input.heterogeneity.p, "heterogeneity.p");
  }
  if (input.egger !== null) {
    requireFinite(input.egger.p, "egger.p");
    requireFinite(input.egger.k, "egger.k");
  }
  input.studies.forEach((study, index) => {
    requireFinite(study.weightPct, `studies[${index}].weightPct`);
    if (study.n !== null) requireFinite(study.n, `studies[${index}].n`);
  });
}

/** Effect estimate / CI bound formatting for human-facing rationale prose. */
function fmtEstimateForProse(value: number): string {
  if (!Number.isFinite(value)) return "—";
  return Math.abs(value) >= 100 ? value.toFixed(1) : value.toFixed(2);
}

const JUDGMENT_PROSE: Record<GradeJudgmentId, string> = {
  NOT_SERIOUS: "not serious",
  SERIOUS: "serious",
  VERY_SERIOUS: "very serious",
};

/**
 * GRADE certainty arithmetic: start at 4 (HIGH) or 2 (LOW) points, subtract 1 per
 * SERIOUS and 2 per VERY_SERIOUS judgment, floor at 1. 4 HIGH / 3 MODERATE / 2 LOW /
 * 1 VERY_LOW.
 */
export function computeCertainty(
  startingLevel: "HIGH" | "LOW",
  judgments: GradeJudgmentId[],
): { points: number; certainty: GradeCertaintyId } {
  let points = startingLevel === "HIGH" ? 4 : 2;
  for (const judgment of judgments) {
    if (judgment === "SERIOUS") points -= 1;
    else if (judgment === "VERY_SERIOUS") points -= 2;
  }
  points = Math.max(1, points);
  const certainty: GradeCertaintyId =
    points >= 4 ? "HIGH" : points === 3 ? "MODERATE" : points === 2 ? "LOW" : "VERY_LOW";
  return { points, certainty };
}

/** Deterministic Tier-1 draft for all five domains, in canonical display order. */
export function draftGradeRatings(input: GradeRulesInput): GradeDraft {
  const pooled = input.pooled;
  if (pooled === null) {
    // The grade service refuses to draft when nothing pools (k = 0), so a missing pooled
    // estimate is a caller bug — fail loudly rather than fabricate unfounded ratings.
    throw new Error("draftGradeRatings: pooled estimate is required (k = 0 cannot be drafted)");
  }
  validateFiniteInputs(input, pooled);
  const ratings: DomainDraft[] = [
    riskOfBias(input),
    inconsistency(input),
    indirectness(),
    imprecision(input, pooled),
    publicationBias(input),
  ];
  const { points, certainty } = computeCertainty(
    input.startingLevel,
    ratings.map((r) => r.judgment),
  );
  return { ratings, points, certainty };
}

const ROB_BUCKET_ORDER: RobBucket[] = ["low", "moderate", "high", "unclear", "unassessed"];

function riskOfBias(input: GradeRulesInput): DomainDraft {
  const weightByBucket: Record<RobBucket, number> = {
    low: 0,
    moderate: 0,
    high: 0,
    unclear: 0,
    unassessed: 0,
  };
  const countByBucket: Record<RobBucket, number> = {
    low: 0,
    moderate: 0,
    high: 0,
    unclear: 0,
    unassessed: 0,
  };
  let uncertainClassificationWeight = 0;
  for (const study of input.studies) {
    weightByBucket[study.rob.bucket] += study.weightPct;
    countByBucket[study.rob.bucket] += 1;
    if (!study.rob.classificationCertain) uncertainClassificationWeight += study.weightPct;
  }
  const weightPctByBucket = {
    low: round4(weightByBucket.low),
    moderate: round4(weightByBucket.moderate),
    high: round4(weightByBucket.high),
    unclear: round4(weightByBucket.unclear),
    unassessed: round4(weightByBucket.unassessed),
  };
  const wHigh = weightPctByBucket.high;
  const wConcern = round4(
    weightPctByBucket.high +
      weightPctByBucket.moderate +
      weightPctByBucket.unclear +
      weightPctByBucket.unassessed,
  );
  const wUnresolved = round4(weightPctByBucket.unclear + weightPctByBucket.unassessed);
  const wUncertain = round4(uncertainClassificationWeight);

  let judgment: GradeJudgmentId;
  let ruleText: string;
  if (wHigh >= ROB_VERY_SERIOUS_HIGH_WEIGHT) {
    judgment = "VERY_SERIOUS";
    ruleText = `${wHigh}% of pooled weight is at high risk of bias (>= ${ROB_VERY_SERIOUS_HIGH_WEIGHT}%)`;
  } else if (wHigh >= ROB_SERIOUS_HIGH_WEIGHT) {
    judgment = "SERIOUS";
    ruleText = `${wHigh}% of pooled weight is at high risk of bias (>= ${ROB_SERIOUS_HIGH_WEIGHT}%)`;
  } else if (wConcern >= ROB_SERIOUS_CONCERN_WEIGHT) {
    judgment = "SERIOUS";
    ruleText = `${wConcern}% of pooled weight carries risk-of-bias concerns (high + moderate + unclear + unassessed >= ${ROB_SERIOUS_CONCERN_WEIGHT}%)`;
  } else {
    judgment = "NOT_SERIOUS";
    ruleText = `high-risk weight ${wHigh}% is below ${ROB_SERIOUS_HIGH_WEIGHT}% and combined concern weight ${wConcern}% is below ${ROB_SERIOUS_CONCERN_WEIGHT}%`;
  }

  const toolNames = [
    ...new Set(
      input.studies.map((s) => s.rob.toolName).filter((name): name is string => name !== null),
    ),
  ];
  const bucketSummary = ROB_BUCKET_ORDER.filter((bucket) => countByBucket[bucket] > 0)
    .map(
      (bucket) =>
        `${bucket}: ${countByBucket[bucket]} ${countByBucket[bucket] === 1 ? "study" : "studies"} (${weightPctByBucket[bucket]}% weight)`,
    )
    .join("; ");

  const sentences = [
    `Risk of bias across ${input.studies.length} pooled ${input.studies.length === 1 ? "study" : "studies"}${toolNames.length > 0 ? ` (${toolNames.join(", ")})` : ""} — ${bucketSummary || "no per-study assessments"}.`,
    `Judged ${JUDGMENT_PROSE[judgment]}: ${ruleText}.`,
  ];
  if (wUnresolved > 0) {
    sentences.push(
      `${wUnresolved}% of weight is unclear or unassessed — review before accepting this rating.`,
    );
  }
  if (wUncertain > 0) {
    sentences.push(
      `${wUncertain}% of weight uses an uncertain risk-of-bias classification — review the tool's severity scale before accepting this rating.`,
    );
  }

  return {
    domain: "RISK_OF_BIAS",
    judgment,
    rationale: sentences.join(" "),
    requiresReview: wUnresolved > 0 || wUncertain > 0,
    metrics: {
      weightPctByBucket,
      uncertainClassificationWeightPct: wUncertain,
      perStudy: input.studies.map((s) => ({
        studyId: s.studyId,
        label: s.label,
        judgmentLabel: s.rob.judgmentLabel,
        bucket: s.rob.bucket,
        classificationCertain: s.rob.classificationCertain,
        provenance: s.rob.provenance,
        judgment: s.rob.judgment,
        toolId: s.rob.toolId,
        toolName: s.rob.toolName,
        weightPct: round4(s.weightPct),
      })),
      thresholds: {
        verySeriousHighWeight: ROB_VERY_SERIOUS_HIGH_WEIGHT,
        seriousHighWeight: ROB_SERIOUS_HIGH_WEIGHT,
        seriousConcernWeight: ROB_SERIOUS_CONCERN_WEIGHT,
      },
    },
  };
}

function inconsistency(input: GradeRulesInput): DomainDraft {
  const { k, heterogeneity } = input;
  if (k < 2 || heterogeneity === null) {
    return {
      domain: "INCONSISTENCY",
      judgment: "NOT_SERIOUS",
      rationale: `Single study (k = ${k}) — heterogeneity not assessable, so inconsistency cannot be rated from the data. Review consistency with any evidence outside this synthesis.`,
      requiresReview: true,
      metrics: { i2: null, q: null, df: null, p: null, k },
    };
  }
  const i2 = round4(heterogeneity.i2);
  const q = round4(heterogeneity.q);
  const p = round4(heterogeneity.p);
  let judgment: GradeJudgmentId;
  let band: string;
  if (i2 < I2_SERIOUS_THRESHOLD) {
    judgment = "NOT_SERIOUS";
    band = `below the ${I2_SERIOUS_THRESHOLD}% threshold for important heterogeneity`;
  } else if (i2 <= I2_VERY_SERIOUS_THRESHOLD) {
    judgment = "SERIOUS";
    band = `within the ${I2_SERIOUS_THRESHOLD}–${I2_VERY_SERIOUS_THRESHOLD}% band (substantial heterogeneity)`;
  } else {
    judgment = "VERY_SERIOUS";
    band = `above ${I2_VERY_SERIOUS_THRESHOLD}% (considerable heterogeneity)`;
  }
  return {
    domain: "INCONSISTENCY",
    judgment,
    rationale: `I² = ${i2}% across k = ${k} studies (Q = ${q}, df = ${heterogeneity.df}, p = ${p}) — ${band}.`,
    requiresReview: false,
    metrics: {
      i2,
      q,
      df: heterogeneity.df,
      p,
      k,
    },
  };
}

function indirectness(): DomainDraft {
  return {
    domain: "INDIRECTNESS",
    judgment: "NOT_SERIOUS",
    rationale:
      "Not downgraded automatically: applicability is a human judgment. Review whether " +
      "each pooled study's population, intervention, comparator and outcome match the " +
      "protocol PICO before accepting this rating.",
    requiresReview: true,
    metrics: { automated: false },
  };
}

function imprecision(
  input: GradeRulesInput,
  pooled: NonNullable<GradeRulesInput["pooled"]>,
): DomainDraft {
  const { totalN } = input;
  const oisShort = totalN !== null && totalN < OIS_THRESHOLD;
  const estimate = round4(pooled.estimate);
  const ciLow = round4(pooled.ciLow);
  const ciHigh = round4(pooled.ciHigh);

  if (input.measure === "PROPORTION") {
    const ciWidth = round4(ciHigh - ciLow);
    const nText =
      totalN === null
        ? `total sample size unavailable — the optimal information size heuristic (${OIS_THRESHOLD} participants) was not applied`
        : `total N = ${totalN} ${oisShort ? "falls short of" : "meets"} the optimal information size heuristic of ${OIS_THRESHOLD} participants`;
    return {
      domain: "IMPRECISION",
      judgment: oisShort ? "SERIOUS" : "NOT_SERIOUS",
      rationale: `Pooled proportion 95% CI ${fmtEstimateForProse(ciLow)} to ${fmtEstimateForProse(ciHigh)} (width ${round4(ciWidth)}); ${nText}. Single-arm proportion — no null-crossing test; review the CI width against a clinically meaningful precision.`,
      requiresReview: true,
      metrics: {
        ciLow,
        ciHigh,
        ciWidth,
        totalN,
        oisShort,
      },
    };
  }

  // Comparative measures. Fall back to the measure's canonical null if the caller
  // passed null (1 on the ratio display scale, 0 on difference scales).
  const isRatio = input.measure === "RR" || input.measure === "OR";
  const nullValue = round4(input.nullValue ?? (isRatio ? 1 : 0));
  const crossesNull = ciLow <= nullValue && ciHigh >= nullValue;

  const isSmd = input.measure === "SMD";
  const appreciableLow = isRatio ? RATIO_APPRECIABLE_LOW : isSmd ? -SMD_APPRECIABLE_BOUND : null;
  const appreciableHigh = isRatio ? RATIO_APPRECIABLE_HIGH : isSmd ? SMD_APPRECIABLE_BOUND : null;
  const crossesBoth =
    appreciableLow !== null &&
    appreciableHigh !== null &&
    ciLow < appreciableLow &&
    ciHigh > appreciableHigh;
  const noAppreciableBounds = appreciableLow === null; // MD/RD/GENERIC_IV: no default MID

  const strikes = (crossesNull ? 1 : 0) + (oisShort ? 1 : 0);
  const judgment: GradeJudgmentId = crossesBoth
    ? "VERY_SERIOUS"
    : strikes === 0
      ? "NOT_SERIOUS"
      : strikes === 1
        ? "SERIOUS"
        : "VERY_SERIOUS";

  const sentences = [
    `Pooled ${input.measure} ${fmtEstimateForProse(estimate)} (95% CI ${fmtEstimateForProse(ciLow)} to ${fmtEstimateForProse(ciHigh)}) ${crossesNull ? "crosses" : "does not cross"} the null value of ${nullValue}.`,
  ];
  if (crossesBoth) {
    sentences.push(
      `The CI spans both appreciable-effect bounds (${fmtEstimateForProse(appreciableLow)} and ${fmtEstimateForProse(appreciableHigh)}) — very serious imprecision regardless of sample size.`,
    );
  }
  sentences.push(
    totalN === null
      ? `Total sample size unavailable — the optimal information size heuristic (${OIS_THRESHOLD} participants) was not applied; review the sample size.`
      : `Total N = ${totalN} ${oisShort ? "falls short of" : "meets"} the optimal information size heuristic of ${OIS_THRESHOLD} participants.`,
  );
  if (noAppreciableBounds && crossesNull) {
    sentences.push(
      `No default appreciable-effect bounds exist for ${input.measure} — review whether the interval includes clinically important effects.`,
    );
  }
  if (!crossesBoth) {
    sentences.push(
      strikes === 0
        ? "No imprecision concerns."
        : `${strikes} imprecision ${strikes === 1 ? "concern" : "concerns"}.`,
    );
  }

  return {
    domain: "IMPRECISION",
    judgment,
    rationale: sentences.join(" "),
    requiresReview: totalN === null || (noAppreciableBounds && crossesNull),
    metrics: {
      estimate,
      ciLow,
      ciHigh,
      nullValue,
      crossesNull,
      crossesBoth,
      ...(appreciableLow !== null && appreciableHigh !== null
        ? { appreciableLow, appreciableHigh }
        : {}),
      totalN,
      oisThreshold: OIS_THRESHOLD,
      oisShort,
    },
  };
}

function publicationBias(input: GradeRulesInput): DomainDraft {
  const { k, egger } = input;
  const eggerP = egger === null ? null : round4(egger.p);
  const metrics = {
    k,
    eggerP,
    eggerThreshold: EGGER_P_THRESHOLD,
  };
  if (k < PUBLICATION_BIAS_MIN_K) {
    return {
      domain: "PUBLICATION_BIAS",
      judgment: "NOT_SERIOUS",
      rationale: `k = ${k} pooled studies is below the ~${PUBLICATION_BIAS_MIN_K}-study minimum for funnel-based small-study tests — publication bias was not statistically assessed. Review qualitatively (search comprehensiveness, registry checks).`,
      requiresReview: true,
      metrics,
    };
  }
  if (egger === null) {
    return {
      domain: "PUBLICATION_BIAS",
      judgment: "NOT_SERIOUS",
      rationale: `Egger's regression test was degenerate for these k = ${k} studies (e.g. identical precisions), so small-study effects could not be tested — review the funnel plot directly.`,
      requiresReview: true,
      metrics,
    };
  }
  if (eggerP! < EGGER_P_THRESHOLD) {
    return {
      domain: "PUBLICATION_BIAS",
      judgment: "SERIOUS",
      rationale: `Egger's test p = ${eggerP} < ${EGGER_P_THRESHOLD} across k = ${k} studies — funnel-plot asymmetry suggests possible small-study effects.`,
      requiresReview: false,
      metrics,
    };
  }
  return {
    domain: "PUBLICATION_BIAS",
    judgment: "NOT_SERIOUS",
    rationale: `Egger's test p = ${eggerP} >= ${EGGER_P_THRESHOLD} across k = ${k} studies — no statistical evidence of funnel-plot asymmetry, but statistical tests cannot rule out publication bias; review search comprehensiveness.`,
    requiresReview: true,
    metrics,
  };
}
