// Chi-square upper-tail probability via the regularized incomplete gamma function.
//
// Pure, deterministic numerics — no dependencies. The regularized gamma helpers
// (gammp/gammq) live here and are shared: normal.ts imports gammq to build erfc.
// Algorithms follow Numerical Recipes (gser series / gcf continued fraction with
// modified Lentz), with a high-precision Lanczos log-gamma so results agree with
// scipy to well beyond the fixture tolerances.

const ITMAX = 300;
const EPS = 1e-15; // relative convergence threshold (double precision)
const FPMIN = 1e-300; // guard against division underflow in Lentz's method

// Lanczos approximation (g = 7, 9 terms), ~15 significant digits for z >= 0.5.
// All callers here use a = 0.5 (erfc) or a = df/2 >= 0.5, so no reflection needed.
// (studentt.ts shares this for the incomplete beta, also with arguments >= 0.5.)
const LANCZOS = [
  0.99999999999980993, 676.5203681218851, -1259.1392167224028, 771.32342877765313,
  -176.61502916214059, 12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6,
  1.5056327351493116e-7,
];
const HALF_LOG_TWO_PI = 0.9189385332046727; // 0.5 * ln(2*pi)

/** Log-gamma (Lanczos). Valid for z >= 0.5 — sufficient for this library. */
export function lgamma(z: number): number {
  // Valid for z >= 0.5 (sufficient for this library).
  let series = LANCZOS[0]!;
  for (let i = 1; i < LANCZOS.length; i++) {
    series += LANCZOS[i]! / (z - 1 + i);
  }
  const t = z + 6.5; // (z - 1) + g + 0.5
  return HALF_LOG_TWO_PI + (z - 0.5) * Math.log(t) - t + Math.log(series);
}

// Series representation of P(a, x); converges fastest for x < a + 1.
function gser(a: number, x: number): number {
  if (x <= 0) return 0;
  let ap = a;
  let sum = 1 / a;
  let del = sum;
  for (let i = 0; i < ITMAX; i++) {
    ap += 1;
    del *= x / ap;
    sum += del;
    if (Math.abs(del) < Math.abs(sum) * EPS) break;
  }
  return sum * Math.exp(-x + a * Math.log(x) - lgamma(a));
}

// Continued-fraction representation of Q(a, x) via modified Lentz; for x >= a + 1.
function gcf(a: number, x: number): number {
  let b = x + 1 - a;
  let c = 1 / FPMIN;
  let d = 1 / b;
  let h = d;
  for (let i = 1; i <= ITMAX; i++) {
    const an = -i * (i - a);
    b += 2;
    d = an * d + b;
    if (Math.abs(d) < FPMIN) d = FPMIN;
    c = b + an / c;
    if (Math.abs(c) < FPMIN) c = FPMIN;
    d = 1 / d;
    const del = d * c;
    h *= del;
    if (Math.abs(del - 1) < EPS) break;
  }
  return Math.exp(-x + a * Math.log(x) - lgamma(a)) * h;
}

/** Regularized lower incomplete gamma P(a, x). */
export function gammp(a: number, x: number): number {
  if (!Number.isFinite(a) || !Number.isFinite(x) || a <= 0 || x < 0) return NaN;
  if (x === 0) return 0;
  return x < a + 1 ? gser(a, x) : 1 - gcf(a, x);
}

/** Regularized upper incomplete gamma Q(a, x) = 1 - P(a, x). */
export function gammq(a: number, x: number): number {
  if (!Number.isFinite(a) || !Number.isFinite(x) || a <= 0 || x < 0) return NaN;
  if (x === 0) return 1;
  return x < a + 1 ? 1 - gser(a, x) : gcf(a, x);
}

/** Upper-tail probability P(X > x) for a chi-square variable with df degrees of freedom. */
export function chiSquareUpperTail(x: number, df: number): number {
  if (!Number.isFinite(x) || !Number.isFinite(df) || df <= 0) return NaN;
  if (x <= 0) return 1;
  return gammq(df / 2, x / 2);
}
