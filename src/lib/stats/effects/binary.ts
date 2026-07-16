// Per-study effect estimates for binary (2x2) outcomes: RR, OR, RD.
//
// Pinned policy (mirrored by the Python reference in scripts/generate-stats-fixtures.py):
// - Counts must be integers with 0 <= e <= n and n >= 1, else the study is excluded.
// - Double-zero (e1 = e2 = 0) and double-full (e1 = n1, e2 = n2) studies are excluded
//   for RR and OR; RD still computes (after the continuity correction below).
// - If ANY of the four cells (e1, n1-e1, e2, n2-e2) is zero, 0.5 is added to ALL FOUR
//   cells — uniformly for every measure, including RD. Corrected cells feed the
//   estimate and SE formulas (so group totals become n + 1).
// Never throws: bad data comes back as { excludedReason }.

import type { BinaryCounts, EffectEstimate } from "../types";

export type BinaryEffectResult = { estimate: EffectEstimate } | { excludedReason: string };

function isCount(v: number): boolean {
  return Number.isFinite(v) && Number.isInteger(v);
}

export function binaryEffect(
  measure: "RR" | "OR" | "RD",
  counts: BinaryCounts,
): BinaryEffectResult {
  const { e1, n1, e2, n2 } = counts;

  if (!isCount(e1) || !isCount(n1) || !isCount(e2) || !isCount(n2)) {
    return { excludedReason: "invalid counts: events and totals must be integers" };
  }
  if (n1 < 1 || n2 < 1 || e1 < 0 || e2 < 0 || e1 > n1 || e2 > n2) {
    return {
      excludedReason:
        "invalid counts: requires 0 ≤ events ≤ total and total ≥ 1 in both groups",
    };
  }

  if (measure === "RR" || measure === "OR") {
    if (e1 === 0 && e2 === 0) {
      return {
        excludedReason: `double-zero study (no events in either group) — excluded from ${measure}`,
      };
    }
    if (e1 === n1 && e2 === n2) {
      return {
        excludedReason: `double-full study (all events in both groups) — excluded from ${measure}`,
      };
    }
  }

  // 2x2 cells: a = events1, b = non-events1, c = events2, d = non-events2.
  let a = e1;
  let b = n1 - e1;
  let c = e2;
  let d = n2 - e2;
  if (a === 0 || b === 0 || c === 0 || d === 0) {
    a += 0.5;
    b += 0.5;
    c += 0.5;
    d += 0.5;
  }
  const t1 = a + b;
  const t2 = c + d;

  if (measure === "RR") {
    const y = Math.log(a / t1 / (c / t2));
    const se = Math.sqrt(1 / a - 1 / t1 + 1 / c - 1 / t2);
    return { estimate: { y, se } };
  }
  if (measure === "OR") {
    const y = Math.log((a * d) / (c * b));
    const se = Math.sqrt(1 / a + 1 / b + 1 / c + 1 / d);
    return { estimate: { y, se } };
  }
  // RD
  const p1 = a / t1;
  const p2 = c / t2;
  const y = p1 - p2;
  const se = Math.sqrt((p1 * (1 - p1)) / t1 + (p2 * (1 - p2)) / t2);
  return { estimate: { y, se } };
}
