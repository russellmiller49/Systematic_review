// Standard normal distribution: quantile (qnorm) and CDF (pnorm).
//
// Pure, deterministic numerics.
// - qnorm implements Wichura's AS 241 (PPND16), accurate to ~1e-15.
// - pnorm is built on erfc via the regularized upper incomplete gamma
//   (erfc(x) = Q(1/2, x^2) for x >= 0, symmetry otherwise), shared from
//   chisq.ts; absolute accuracy ~1e-10 or better across the real line.

import { gammq } from "./chisq";

// ---------------------------------------------------------------------------
// qnorm — Wichura (1988), Algorithm AS 241, double-precision variant PPND16.
// ---------------------------------------------------------------------------

/** Inverse standard normal CDF. Returns ±Infinity at p = 0/1, NaN outside [0, 1]. */
export function qnorm(p: number): number {
  if (Number.isNaN(p) || p < 0 || p > 1) return NaN;
  if (p === 0) return -Infinity;
  if (p === 1) return Infinity;

  const q = p - 0.5;
  if (Math.abs(q) <= 0.425) {
    // Central region: rational approximation in r = 0.180625 - q^2.
    const r = 0.180625 - q * q;
    return (
      (q *
        (((((((2.5090809287301226727e3 * r + 3.3430575583588128105e4) * r +
          6.7265770927008700853e4) *
          r +
          4.5921953931549871457e4) *
          r +
          1.3731693765509461125e4) *
          r +
          1.9715909503065514427e3) *
          r +
          1.3314166789178437745e2) *
          r +
          3.3871328727963666080e0)) /
      (((((((5.22649527885254561e3 * r + 2.8729085735721942674e4) * r +
        3.9307895800092710610e4) *
        r +
        2.1213794301586595867e4) *
        r +
        5.3941960214247511077e3) *
        r +
        6.8718700749205790830e2) *
        r +
        4.2313330701600911252e1) *
        r +
        1)
    );
  }

  // Tail regions: rational approximations in r = sqrt(-ln(min(p, 1-p))).
  let r = q < 0 ? p : 1 - p;
  r = Math.sqrt(-Math.log(r));
  let val: number;
  if (r <= 5) {
    r -= 1.6;
    val =
      (((((((7.74545014278341407640e-4 * r + 2.27238449892691845833e-2) * r +
        2.41780725177450611770e-1) *
        r +
        1.27045825245236838258e0) *
        r +
        3.64784832476320460504e0) *
        r +
        5.76949722146069140550e0) *
        r +
        4.63033784615654529590e0) *
        r +
        1.42343711074968357734e0) /
      (((((((1.05075007164441684324e-9 * r + 5.47593808499534494600e-4) * r +
        1.51986665636164571966e-2) *
        r +
        1.48103976427480074590e-1) *
        r +
        6.89767334985100004550e-1) *
        r +
        1.67638483018380384940e0) *
        r +
        2.05319162663775882187e0) *
        r +
        1);
  } else {
    r -= 5;
    val =
      (((((((2.01033439929228813265e-7 * r + 2.71155556874348757815e-5) * r +
        1.24266094738807843860e-3) *
        r +
        2.65321895265761230930e-2) *
        r +
        2.96560571828504891230e-1) *
        r +
        1.78482653991729133580e0) *
        r +
        5.46378491116411436990e0) *
        r +
        6.65790464350110377720e0) /
      (((((((2.04426310338993978564e-15 * r + 1.42151175831644588870e-7) * r +
        1.84631831751005468180e-5) *
        r +
        7.86869131145613259100e-4) *
        r +
        1.48753612908506148525e-2) *
        r +
        1.36929880922735805310e-1) *
        r +
        5.99832206555887937690e-1) *
        r +
        1);
  }
  return q < 0 ? -val : val;
}

// ---------------------------------------------------------------------------
// pnorm — via erfc built on the regularized upper incomplete gamma.
// ---------------------------------------------------------------------------

/** Complementary error function. */
export function erfc(x: number): number {
  if (Number.isNaN(x)) return NaN;
  if (x === Infinity) return 0;
  if (x === -Infinity) return 2;
  // Guard the square: for finite |x| >= sqrt(Number.MAX_VALUE) ≈ 1.34e154,
  // x*x overflows to Infinity and gammq would return NaN; the true value at
  // that magnitude is already fully saturated (0 or 2 to double precision).
  const x2 = x * x;
  if (!Number.isFinite(x2)) return x >= 0 ? 0 : 2;
  return x >= 0 ? gammq(0.5, x2) : 2 - gammq(0.5, x2);
}

/** Standard normal CDF P(Z <= z). */
export function pnorm(z: number): number {
  if (Number.isNaN(z)) return NaN;
  return 0.5 * erfc(-z / Math.SQRT2);
}
