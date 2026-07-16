#!/usr/bin/env python3
"""Independent reference implementation for the meta-analysis stats library.

Generates golden fixtures for src/lib/stats (validated by fixtures.test.ts).
This script implements the SAME pinned policies as the TypeScript library but
shares no code with it; distribution functions come from scipy (norm.ppf/sf,
chi2.sf). Datasets are synthetic and embedded below — nothing is taken from
remembered published analyses.

Pinned policies (must match src/lib/stats exactly):
- Binary: integers, 0 <= e <= n, n >= 1 else excluded. Double-zero/double-full
  excluded for RR/OR (RD still computes). If ANY of the four 2x2 cells is zero,
  add 0.5 to all four cells (all measures, incl. RD).
- Continuous: finite, integer n1,n2 >= 2, sd >= 0 else excluded. MD excluded on
  zero variance; SMD (Hedges g) excluded on zero pooled SD.
- Pooling: inverse-variance fixed effect; DerSimonian-Laird random effects
  (tau2 = max(0, (Q - df) / C), C = Sw - Sw2/Sw). k == 1: both models return
  the single study, heterogeneity is null. CI = y +/- qnorm(0.975) * se,
  p = 2 * pnorm(-|z|), het p = upper-tail chi-square of Q at df.

Run: python3 scripts/generate-stats-fixtures.py
Writes: src/lib/stats/__fixtures__/*.json
"""

import json
import math
import os

from scipy.stats import chi2, norm

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


# ---------------------------------------------------------------------------
# Pooling + full meta computation
# ---------------------------------------------------------------------------


def _pooled(y, se, log_scale):
    z = y / se
    p = float(2 * norm.sf(abs(z)))
    lo, hi = y - Z975 * se, y + Z975 * se
    tx = math.exp if log_scale else (lambda v: v)
    return {
        "y": y,
        "se": se,
        "ciLow": lo,
        "ciHigh": hi,
        "display": {"estimate": tx(y), "ciLow": tx(lo), "ciHigh": tx(hi)},
        "z": z,
        "p": p,
    }


def compute_meta(measure, studies):
    log_scale = measure in ("RR", "OR")
    tx = math.exp if log_scale else (lambda v: v)
    included = []  # (id, label, y, se)
    excluded_ids = []
    for s in studies:
        data = s["data"]
        if measure in ("RR", "OR", "RD"):
            eff = binary_effect(measure, data["counts"]) if data["kind"] == "binary" else None
        else:
            eff = (
                continuous_effect(measure, data["stats"])
                if data["kind"] == "continuous"
                else None
            )
        if eff is None:
            excluded_ids.append(s["id"])
        else:
            included.append((s["id"], s["label"], eff[0], eff[1]))

    out = {
        "studies": [],
        "excludedIds": excluded_ids,
        "fixed": None,
        "random": None,
        "heterogeneity": None,
    }
    k = len(included)
    if k == 0:
        return out

    ys = [y for (_, _, y, _) in included]
    vs = [se * se for (_, _, _, se) in included]
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

    out["fixed"] = _pooled(yf, sef, log_scale)
    out["random"] = _pooled(yr, ser, log_scale)

    for i, (sid, label, y, se) in enumerate(included):
        lo, hi = y - Z975 * se, y + Z975 * se
        out["studies"].append(
            {
                "id": sid,
                "label": label,
                "y": y,
                "se": se,
                "ciLow": lo,
                "ciHigh": hi,
                "display": {"estimate": tx(y), "ciLow": tx(lo), "ciHigh": tx(hi)},
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

FIXTURES = [
    ("binary-rr", "RR", BINARY_SET),
    ("binary-or", "OR", BINARY_SET),
    ("binary-rd", "RD", BINARY_SET),
    ("md", "MD", MD_SET),
    ("smd", "SMD", SMD_SET),
    ("homogeneous-rr", "RR", HOMOGENEOUS_SET),
    ("single-study-rr", "RR", SINGLE_SET),
    ("all-excluded-rr", "RR", ALL_EXCLUDED_SET),
]


def main():
    os.makedirs(OUT_DIR, exist_ok=True)
    for name, measure, studies in FIXTURES:
        fixture = {
            "name": name,
            "measure": measure,
            "studies": studies,
            "expected": compute_meta(measure, studies),
        }
        path = os.path.join(OUT_DIR, f"{name}.json")
        with open(path, "w") as f:
            json.dump(fixture, f, indent=2)
            f.write("\n")
        print(f"wrote {os.path.relpath(path)}")


if __name__ == "__main__":
    main()
