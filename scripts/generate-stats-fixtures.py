#!/usr/bin/env python3
"""Independent reference implementation for the meta-analysis stats library.

Generates golden fixtures for src/lib/stats (validated by fixtures.test.ts).
This script implements the SAME pinned policies as the TypeScript library but
shares no code with it; distribution functions come from scipy (norm.ppf/sf,
chi2.sf, t.ppf/sf) and Egger's regression from scipy.stats.linregress. Datasets
are synthetic and embedded below — nothing is taken from remembered published
analyses.

Pinned policies (must match src/lib/stats exactly):
- Binary: integers, 0 <= e <= n, n >= 1 else excluded. Double-zero/double-full
  excluded for RR/OR (RD still computes). If ANY of the four 2x2 cells is zero,
  add 0.5 to all four cells (all measures, incl. RD).
- Continuous: finite, integer n1,n2 >= 2, sd >= 0 else excluded. MD excluded on
  zero variance; SMD (Hedges g) excluded on zero pooled SD.
- Proportion (single arm; integers, 0 <= e <= n, n >= 1 else excluded):
  LOGIT: continuity only when e = 0 or e = n: e' = e + 0.5, n' = n + 1;
  y = ln(e'/(n'-e')), v = 1/e' + 1/(n'-e'); display p = 1/(1+exp(-y)).
  FREEMAN_TUKEY: y = 0.5*(asin(sqrt(e/(n+1))) + asin(sqrt((e+1)/(n+1)))),
  v = 1/(4n+2); display via Miller (1978) inverse with the study's own n
  (pooled values with the HARMONIC MEAN of included n's), y clamped to
  [0, pi/2] then to the achievable range [pft(0,n), pft(1,n)], sqrt argument
  clamped to [0,1], p clamped to [0,1].
- Generic IV: y finite; se (finite, > 0) wins when present, else BOTH ci bounds
  required with ciUp > ciLow and ciLow <= y <= ciUp; se = (ciUp - ciLow) /
  (2 * 1.959963984540054). Pools as entered (identity display, null value 0).
- Pooling: inverse-variance fixed effect; DerSimonian-Laird random effects
  (tau2 = max(0, (Q - df) / C), C = Sw - Sw2/Sw). k == 1: both models return
  the single study, heterogeneity is null. CI = y +/- qnorm(0.975) * se,
  p = 2 * pnorm(-|z|), het p = upper-tail chi-square of Q at df.
- Prediction interval (k >= 3 else null; Higgins/Thompson/Spiegelhalter):
  PI = y_RE +/- t.ppf(0.975, k-2) * sqrt(tau2 + se_RE^2).
- Egger (k >= 3 else null): OLS of z_i = y_i/se_i on 1/se_i via
  scipy.stats.linregress; t = intercept/intercept_stderr, two-sided Student-t
  p at df = k-2.

Run: python3 scripts/generate-stats-fixtures.py
Writes: src/lib/stats/__fixtures__/*.json (pins-*.json carry scalar pin grids)
"""

import json
import math
import os

from scipy.stats import chi2, linregress, norm
from scipy.stats import t as tdist

OUT_DIR = os.path.join(
    os.path.dirname(os.path.abspath(__file__)), "..", "src", "lib", "stats", "__fixtures__"
)
Z975 = float(norm.ppf(0.975))

# ---------------------------------------------------------------------------
# Per-study effects
# ---------------------------------------------------------------------------


def _is_count(v):
    return isinstance(v, (int, float)) and math.isfinite(v) and float(v).is_integer()


def binary_effect(measure, c):
    """Return (y, se) on the analysis scale, or None if excluded."""
    e1, n1, e2, n2 = c["e1"], c["n1"], c["e2"], c["n2"]
    if not all(_is_count(v) for v in (e1, n1, e2, n2)):
        return None
    if n1 < 1 or n2 < 1 or e1 < 0 or e2 < 0 or e1 > n1 or e2 > n2:
        return None
    if measure in ("RR", "OR") and (
        (e1 == 0 and e2 == 0) or (e1 == n1 and e2 == n2)
    ):
        return None
    # 2x2 cells: a = e1, b = n1-e1, c = e2, d = n2-e2
    a, b, cc, d = float(e1), float(n1 - e1), float(e2), float(n2 - e2)
    if a == 0 or b == 0 or cc == 0 or d == 0:
        a, b, cc, d = a + 0.5, b + 0.5, cc + 0.5, d + 0.5
    t1, t2 = a + b, cc + d
    if measure == "RR":
        y = math.log((a / t1) / (cc / t2))
        se = math.sqrt(1 / a - 1 / t1 + 1 / cc - 1 / t2)
    elif measure == "OR":
        y = math.log((a * d) / (cc * b))
        se = math.sqrt(1 / a + 1 / b + 1 / cc + 1 / d)
    else:  # RD
        p1, p2 = a / t1, cc / t2
        y = p1 - p2
        se = math.sqrt(p1 * (1 - p1) / t1 + p2 * (1 - p2) / t2)
    return (y, se)


def continuous_effect(measure, s):
    m1, sd1, n1 = s["m1"], s["sd1"], s["n1"]
    m2, sd2, n2 = s["m2"], s["sd2"], s["n2"]
    vals = (m1, sd1, n1, m2, sd2, n2)
    if not all(isinstance(v, (int, float)) and math.isfinite(v) for v in vals):
        return None
    if not (_is_count(n1) and _is_count(n2)) or n1 < 2 or n2 < 2:
        return None
    if sd1 < 0 or sd2 < 0:
        return None
    if measure == "MD":
        se = math.sqrt(sd1 * sd1 / n1 + sd2 * sd2 / n2)
        if se == 0:
            return None
        return (m1 - m2, se)
    # SMD: Hedges g
    sp = math.sqrt(((n1 - 1) * sd1 * sd1 + (n2 - 1) * sd2 * sd2) / (n1 + n2 - 2))
    if sp == 0:
        return None
    d = (m1 - m2) / sp
    j = 1 - 3 / (4 * (n1 + n2 - 2) - 1)
    g = j * d
    v = 1 / n1 + 1 / n2 + g * g / (2 * (n1 + n2))
    return (g, math.sqrt(v))


def proportion_effect(transform, c):
    e, n = c["e"], c["n"]
    if not (_is_count(e) and _is_count(n)):
        return None
    if n < 1 or e < 0 or e > n:
        return None
    if transform == "LOGIT":
        if e == 0 or e == n:
            ea, na = e + 0.5, n + 1
        else:
            ea, na = float(e), float(n)
        y = math.log(ea / (na - ea))
        v = 1 / ea + 1 / (na - ea)
        return (y, math.sqrt(v))
    # FREEMAN_TUKEY
    y = 0.5 * (math.asin(math.sqrt(e / (n + 1))) + math.asin(math.sqrt((e + 1) / (n + 1))))
    v = 1 / (4 * n + 2)
    return (y, math.sqrt(v))


GENERIC_Z975 = 1.959963984540054  # pinned constant shared with the TS policy


def generic_effect(s):
    y, se, ci_low, ci_up = s["y"], s["se"], s["ciLow"], s["ciUp"]
    if not (isinstance(y, (int, float)) and math.isfinite(y)):
        return None
    if se is not None:
        if not (isinstance(se, (int, float)) and math.isfinite(se) and se > 0):
            return None
        return (float(y), float(se))
    if ci_low is None or ci_up is None:
        return None
    if not all(isinstance(v, (int, float)) and math.isfinite(v) for v in (ci_low, ci_up)):
        return None
    if not ci_up > ci_low:
        return None
    if y < ci_low or y > ci_up:
        return None
    derived = (ci_up - ci_low) / (2 * GENERIC_Z975)
    if not (math.isfinite(derived) and derived > 0):
        return None
    return (float(y), derived)


# ---------------------------------------------------------------------------
# Display transforms
# ---------------------------------------------------------------------------


def inv_logit(y):
    return 1 / (1 + math.exp(-y))


def ft_inverse(y, n):
    """Miller (1978) inverse double-arcsine, metafor-style achievable-range bounds."""
    yc = min(max(y, 0.0), math.pi / 2)
    lower = 0.5 * math.asin(math.sqrt(1 / (n + 1)))
    upper = 0.5 * (math.asin(math.sqrt(n / (n + 1))) + math.pi / 2)
    if yc < lower:
        return 0.0
    if yc > upper:
        return 1.0
    s = math.sin(2 * yc)
    if s == 0:
        return 0.0 if yc < math.pi / 4 else 1.0
    inner = s + (s - 1 / s) / n
    arg = min(max(1 - inner * inner, 0.0), 1.0)
    sign = 1.0 if math.cos(2 * yc) > 0 else (-1.0 if math.cos(2 * yc) < 0 else 0.0)
    p = 0.5 * (1 - sign * math.sqrt(arg))
    return min(max(p, 0.0), 1.0)


def harmonic_mean(ns):
    if not ns:
        return None
    return len(ns) / sum(1 / n for n in ns)


# ---------------------------------------------------------------------------
# Pooling + full meta computation
# ---------------------------------------------------------------------------


def _scale_for(measure, transform):
    if measure in ("RR", "OR"):
        return "log"
    if measure == "PROPORTION":
        return "ft" if transform == "FREEMAN_TUKEY" else "logit"
    return "linear"


def _study_effect(measure, transform, s):
    """Return ((y, se), n_for_ft) or (None, None)."""
    data = s["data"]
    if measure in ("RR", "OR", "RD"):
        eff = binary_effect(measure, data["counts"]) if data["kind"] == "binary" else None
        return eff, None
    if measure in ("MD", "SMD"):
        eff = (
            continuous_effect(measure, data["stats"]) if data["kind"] == "continuous" else None
        )
        return eff, None
    if measure == "PROPORTION":
        if data["kind"] != "proportion":
            return None, None
        eff = proportion_effect(transform, data["counts"])
        return eff, (data["counts"]["n"] if eff is not None else None)
    # GENERIC_IV
    eff = generic_effect(data["stats"]) if data["kind"] == "generic" else None
    return eff, None


def egger_test(ys, ses):
    k = len(ys)
    if k < 3:
        return None
    prec = [1 / se for se in ses]
    z = [y / se for y, se in zip(ys, ses)]
    res = linregress(prec, z)
    if not (math.isfinite(res.intercept) and math.isfinite(res.intercept_stderr)):
        return None
    if res.intercept_stderr <= 0:
        return None
    tval = res.intercept / res.intercept_stderr
    p = 2 * float(tdist.sf(abs(tval), k - 2))
    return {
        "intercept": float(res.intercept),
        "interceptSe": float(res.intercept_stderr),
        "t": float(tval),
        "p": p,
        "k": k,
    }


def compute_meta(measure, studies, transform="LOGIT"):
    scale = _scale_for(measure, transform)

    included = []  # (id, label, y, se, n_for_ft)
    excluded_ids = []
    for s in studies:
        eff, n_ft = _study_effect(measure, transform, s)
        if eff is None:
            excluded_ids.append(s["id"])
        else:
            included.append((s["id"], s["label"], eff[0], eff[1], n_ft))

    harmonic_n = None
    if scale == "ft":
        harmonic_n = harmonic_mean([n for (_, _, _, _, n) in included if n is not None])

    def tx(v, ft_n):
        if scale == "log":
            return math.exp(v)
        if scale == "logit":
            return inv_logit(v)
        if scale == "ft":
            return ft_inverse(v, ft_n) if ft_n is not None else v
        return v

    def pooled_block(y, se):
        z = y / se
        p = float(2 * norm.sf(abs(z)))
        lo, hi = y - Z975 * se, y + Z975 * se
        return {
            "y": y,
            "se": se,
            "ciLow": lo,
            "ciHigh": hi,
            "display": {
                "estimate": tx(y, harmonic_n),
                "ciLow": tx(lo, harmonic_n),
                "ciHigh": tx(hi, harmonic_n),
            },
            "z": z,
            "p": p,
        }

    out = {
        "studies": [],
        "excludedIds": excluded_ids,
        "fixed": None,
        "random": None,
        "heterogeneity": None,
        "predictionInterval": None,
        "egger": None,
        "displayMeta": {
            "transform": {"log": "exp", "logit": "invlogit", "ft": "ft"}.get(scale, "identity"),
            "harmonicN": harmonic_n,
        },
    }
    k = len(included)
    if k == 0:
        return out

    ys = [y for (_, _, y, _, _) in included]
    ses = [se for (_, _, _, se, _) in included]
    vs = [se * se for se in ses]
    w = [1 / v for v in vs]
    sw = sum(w)
    yf = sum(wi * yi for wi, yi in zip(w, ys)) / sw
    sef = math.sqrt(1 / sw)

    tau2 = 0.0
    if k >= 2:
        q = sum(wi * (yi - yf) ** 2 for wi, yi in zip(w, ys))
        df = k - 1
        c = sw - sum(wi * wi for wi in w) / sw
        tau2 = max(0.0, (q - df) / c)
        i2 = max(0.0, (q - df) / q) * 100.0 if q > 0 else 0.0
        out["heterogeneity"] = {
            "q": q,
            "df": df,
            "p": float(chi2.sf(q, df)),
            "i2": i2,
            "tau2": tau2,
        }

    wr = [1 / (v + tau2) for v in vs]
    swr = sum(wr)
    yr = sum(wi * yi for wi, yi in zip(wr, ys)) / swr
    ser = math.sqrt(1 / swr)

    out["fixed"] = pooled_block(yf, sef)
    out["random"] = pooled_block(yr, ser)

    # Prediction interval: Higgins/Thompson/Spiegelhalter, k >= 3 required.
    if k >= 3:
        half = float(tdist.ppf(0.975, k - 2)) * math.sqrt(tau2 + ser * ser)
        lo, hi = yr - half, yr + half
        out["predictionInterval"] = {
            "low": lo,
            "high": hi,
            "display": {"low": tx(lo, harmonic_n), "high": tx(hi, harmonic_n)},
        }

    out["egger"] = egger_test(ys, ses)

    for i, (sid, label, y, se, n_ft) in enumerate(included):
        lo, hi = y - Z975 * se, y + Z975 * se
        study_n = n_ft if scale == "ft" else None
        out["studies"].append(
            {
                "id": sid,
                "label": label,
                "y": y,
                "se": se,
                "ciLow": lo,
                "ciHigh": hi,
                "display": {
                    "estimate": tx(y, study_n),
                    "ciLow": tx(lo, study_n),
                    "ciHigh": tx(hi, study_n),
                },
                "weightFixedPct": w[i] / sw * 100.0,
                "weightRandomPct": wr[i] / swr * 100.0,
            }
        )
    return out


# ---------------------------------------------------------------------------
# Synthetic datasets (embedded, deterministic)
# ---------------------------------------------------------------------------


def bstudy(sid, label, e1, n1, e2, n2):
    return {
        "id": sid,
        "label": label,
        "data": {"kind": "binary", "counts": {"e1": e1, "n1": n1, "e2": e2, "n2": n2}},
    }


def cstudy(sid, label, m1, sd1, n1, m2, sd2, n2):
    return {
        "id": sid,
        "label": label,
        "data": {
            "kind": "continuous",
            "stats": {"m1": m1, "sd1": sd1, "n1": n1, "m2": m2, "sd2": sd2, "n2": n2},
        },
    }


def pstudy(sid, label, e, n):
    return {
        "id": sid,
        "label": label,
        "data": {"kind": "proportion", "counts": {"e": e, "n": n}},
    }


def gstudy(sid, label, y, se=None, ci_low=None, ci_up=None):
    return {
        "id": sid,
        "label": label,
        "data": {"kind": "generic", "stats": {"y": y, "se": se, "ciLow": ci_low, "ciUp": ci_up}},
    }


# (a) 11-study binary set with heterogeneity: s5 has a single zero cell,
# s6 is double-zero (excluded for RR/OR, computes for RD after correction),
# s11 has a non-integer event count (excluded for every measure).
BINARY_SET = [
    bstudy("b01", "Binary 01", 12, 100, 24, 98),
    bstudy("b02", "Binary 02", 5, 60, 10, 62),
    bstudy("b03", "Binary 03", 30, 250, 22, 245),
    bstudy("b04", "Binary 04", 8, 45, 15, 50),
    bstudy("b05", "Binary 05 (zero cell)", 0, 40, 6, 42),
    bstudy("b06", "Binary 06 (double zero)", 0, 25, 0, 27),
    bstudy("b07", "Binary 07", 55, 400, 80, 405),
    bstudy("b08", "Binary 08", 3, 30, 9, 31),
    bstudy("b09", "Binary 09", 18, 120, 12, 115),
    bstudy("b10", "Binary 10", 40, 300, 65, 310),
    bstudy("b11", "Binary 11 (invalid)", 5.5, 50, 3, 48),
]

# (b) MD set
MD_SET = [
    cstudy("m01", "MD 01", 10.2, 3.1, 40, 12.5, 3.4, 42),
    cstudy("m02", "MD 02", 9.8, 2.7, 35, 11.1, 2.9, 33),
    cstudy("m03", "MD 03", 11.4, 4.0, 50, 11.0, 3.8, 55),
    cstudy("m04", "MD 04", 8.9, 2.2, 28, 12.0, 2.5, 30),
    cstudy("m05", "MD 05", 10.0, 3.5, 60, 10.9, 3.3, 58),
]

# (c) SMD set; s01 is small enough that the Hedges J correction matters.
SMD_SET = [
    cstudy("g01", "SMD 01 (small n)", 50.0, 10.0, 4, 42.0, 9.0, 5),
    cstudy("g02", "SMD 02", 48.0, 11.0, 30, 44.0, 10.0, 32),
    cstudy("g03", "SMD 03", 52.0, 9.5, 25, 49.0, 10.2, 24),
    cstudy("g04", "SMD 04", 47.0, 12.0, 45, 46.0, 11.5, 44),
    cstudy("g05", "SMD 05", 51.0, 10.8, 18, 45.0, 9.9, 20),
]

# (d) 2-study homogeneous set: Q < df so tau2 must hit the max(0, .) floor.
HOMOGENEOUS_SET = [
    bstudy("h01", "Homog 01", 10, 100, 20, 100),
    bstudy("h02", "Homog 02", 21, 200, 41, 200),
]

# (e) single study: fixed == random, heterogeneity null.
SINGLE_SET = [bstudy("s01", "Single 01", 7, 50, 14, 52)]

# (f) everything excluded for RR: double-zero, double-full, invalid counts.
ALL_EXCLUDED_SET = [
    bstudy("x01", "Excl 01 (double zero)", 0, 30, 0, 28),
    bstudy("x02", "Excl 02 (double full)", 30, 30, 28, 28),
    bstudy("x03", "Excl 03 (events > total)", 40, 30, 5, 28),
]

# (g) single-arm proportion set: p02 has zero events (logit continuity), p04 is
# full-event (logit continuity), p06 has a non-integer count (excluded).
PROPORTION_SET = [
    pstudy("p01", "Prop 01", 12, 80),
    pstudy("p02", "Prop 02 (zero events)", 0, 45),
    pstudy("p03", "Prop 03", 30, 60),
    pstudy("p04", "Prop 04 (all events)", 25, 25),
    pstudy("p05", "Prop 05", 5, 120),
    pstudy("p06", "Prop 06 (invalid)", 7.5, 30),
]

# (h) generic IV from estimate + SE.
GENERIC_SE_SET = [
    gstudy("v01", "Gen 01", 0.25, se=0.12),
    gstudy("v02", "Gen 02", -0.10, se=0.20),
    gstudy("v03", "Gen 03", 0.40, se=0.15),
    gstudy("v04", "Gen 04", 0.05, se=0.30),
]

# (i) generic IV with CI-derived SEs; c04's estimate sits outside its CI (excluded),
# c05 has an inverted CI (excluded).
GENERIC_CI_SET = [
    gstudy("c01", "GenCI 01", 0.25, ci_low=0.02, ci_up=0.48),
    gstudy("c02", "GenCI 02", -0.10, ci_low=-0.45, ci_up=0.25),
    gstudy("c03", "GenCI 03", 0.40, ci_low=0.11, ci_up=0.69),
    gstudy("c04", "GenCI 04 (outside CI)", 0.90, ci_low=0.10, ci_up=0.60),
    gstudy("c05", "GenCI 05 (inverted CI)", 0.20, ci_low=0.50, ci_up=0.10),
]

# (j) classic small-study asymmetry (bigger effects with bigger SEs) — the Egger
# reference set, also used for pins-egger.json.
EGGER_ASYMMETRIC_SET = [
    gstudy("e01", "Egger 01", 0.10, se=0.08),
    gstudy("e02", "Egger 02", 0.15, se=0.10),
    gstudy("e03", "Egger 03", 0.22, se=0.14),
    gstudy("e04", "Egger 04", 0.35, se=0.20),
    gstudy("e05", "Egger 05", 0.48, se=0.28),
    gstudy("e06", "Egger 06", 0.60, se=0.35),
    gstudy("e07", "Egger 07", 0.55, se=0.40),
    gstudy("e08", "Egger 08", 0.75, se=0.45),
]

FIXTURES = [
    ("binary-rr", "RR", None, BINARY_SET),
    ("binary-or", "OR", None, BINARY_SET),
    ("binary-rd", "RD", None, BINARY_SET),
    ("md", "MD", None, MD_SET),
    ("smd", "SMD", None, SMD_SET),
    ("homogeneous-rr", "RR", None, HOMOGENEOUS_SET),
    ("single-study-rr", "RR", None, SINGLE_SET),
    ("all-excluded-rr", "RR", None, ALL_EXCLUDED_SET),
    ("proportion-logit", "PROPORTION", "LOGIT", PROPORTION_SET),
    ("proportion-ft", "PROPORTION", "FREEMAN_TUKEY", PROPORTION_SET),
    ("generic-iv-se", "GENERIC_IV", None, GENERIC_SE_SET),
    ("generic-iv-ci", "GENERIC_IV", None, GENERIC_CI_SET),
    ("generic-iv-egger", "GENERIC_IV", None, EGGER_ASYMMETRIC_SET),
]


# ---------------------------------------------------------------------------
# Scalar pin grids (pins-*.json — separate shape from the meta fixtures)
# ---------------------------------------------------------------------------


def qt_pins():
    """scipy.stats.t.ppf over the pinned df x p grid (asserted at 1e-8)."""
    pins = []
    for df in (1, 2, 3, 5, 10, 30, 100):
        for p in (0.6, 0.9, 0.975, 0.995):
            pins.append({"p": p, "df": df, "value": float(tdist.ppf(p, df))})
    return {"kind": "qt", "pins": pins}


def egger_pins():
    ys = [s["data"]["stats"]["y"] for s in EGGER_ASYMMETRIC_SET]
    ses = [s["data"]["stats"]["se"] for s in EGGER_ASYMMETRIC_SET]
    return {"kind": "egger", "ys": ys, "ses": ses, "expected": egger_test(ys, ses)}


def main():
    os.makedirs(OUT_DIR, exist_ok=True)
    for name, measure, transform, studies in FIXTURES:
        fixture = {
            "name": name,
            "measure": measure,
            "proportionTransform": transform,
            "studies": studies,
            "expected": compute_meta(measure, studies, transform or "LOGIT"),
        }
        path = os.path.join(OUT_DIR, f"{name}.json")
        with open(path, "w") as f:
            json.dump(fixture, f, indent=2)
            f.write("\n")
        print(f"wrote {os.path.relpath(path)}")

    for name, payload in (("pins-qt", qt_pins()), ("pins-egger", egger_pins())):
        path = os.path.join(OUT_DIR, f"{name}.json")
        with open(path, "w") as f:
            json.dump(payload, f, indent=2)
            f.write("\n")
        print(f"wrote {os.path.relpath(path)}")


if __name__ == "__main__":
    main()
