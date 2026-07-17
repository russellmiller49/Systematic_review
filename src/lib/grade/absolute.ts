// Summary-of-findings absolute-effect math (anticipated events per 1000 participants).
//
// - medianControlRiskPer1000: median of the per-study comparator risks (e2/n2 fractions),
//   scaled to per-1000; even count -> mean of the middle two; null when empty.
// - absoluteFromRelative: corresponding risk per 1000 for an assumed comparator risk and
//   a pooled relative effect on the DISPLAY scale:
//     RR: assumed × RR;  OR: 1000·(OR·p)/(1 − p + OR·p) with p = assumed/1000;
//     RD: assumed + RD × 1000.  All clamped to 0..1000.
//   Each transform is monotone increasing in the effect, so CI bounds map directly.
//   MD/SMD/GENERIC_IV/PROPORTION -> null (the SoF table shows the effect itself instead).

import type { GradeRulesInput } from "./types";

export interface AbsoluteEffect {
  assumedPer1000: number;
  correspondingPer1000: number;
  correspondingCiLowPer1000: number;
  correspondingCiHighPer1000: number;
}

/** Median of per-study comparator risks (e2/n2), as a per-1000 rate. Null when empty. */
export function medianControlRiskPer1000(risks: number[]): number | null {
  if (risks.length === 0) return null;
  const sorted = [...risks].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const median =
    sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
  return median * 1000;
}

function clampPer1000(x: number): number {
  return Math.min(1000, Math.max(0, x));
}

/** Anticipated absolute effect per 1000 for a relative pooled estimate (display scale). */
export function absoluteFromRelative(
  measure: GradeRulesInput["measure"],
  assumedPer1000: number,
  est: number,
  ciLow: number,
  ciHigh: number,
): AbsoluteEffect | null {
  let transform: (effect: number) => number;
  if (measure === "RR") {
    transform = (rr) => assumedPer1000 * rr;
  } else if (measure === "OR") {
    const p = assumedPer1000 / 1000;
    transform = (or) => {
      if (or === 0) return 0;
      return (1000 * (or * p)) / (1 - p + or * p);
    };
  } else if (measure === "RD") {
    transform = (rd) => assumedPer1000 + rd * 1000;
  } else {
    return null; // MD/SMD/GENERIC_IV/PROPORTION: no relative-to-absolute conversion
  }
  return {
    assumedPer1000,
    correspondingPer1000: clampPer1000(transform(est)),
    correspondingCiLowPer1000: clampPer1000(transform(ciLow)),
    correspondingCiHighPer1000: clampPer1000(transform(ciHigh)),
  };
}
