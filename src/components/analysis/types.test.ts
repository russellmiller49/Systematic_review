// Unit tests for the pure helpers in the analysis client types module.

import { describe, expect, it } from "vitest";
import { ApiError } from "@/lib/api";
import {
  apiErrorMessages,
  fmtCi,
  fmtP,
  fmtValue,
  hasCap,
  isBinaryMeasure,
  resolveGroupLabels,
  roleLabel,
  slugify,
} from "./types";

describe("roleLabel", () => {
  const groups = { g1: "Stent", g2: "Control" };

  it("maps group prefix + suffix to a readable label", () => {
    expect(roleLabel("G1_EVENTS", groups)).toBe("Stent events");
    expect(roleLabel("G2_TOTAL", groups)).toBe("Control total");
    expect(roleLabel("G1_SD", groups)).toBe("Stent SD");
    expect(roleLabel("G2_N", groups)).toBe("Control n");
  });

  it("falls back to the raw key for unknown roles", () => {
    expect(roleLabel("EFFECT_ESTIMATE", groups)).toBe("EFFECT_ESTIMATE");
  });
});

describe("resolveGroupLabels", () => {
  it("defaults missing labels", () => {
    expect(resolveGroupLabels(null)).toEqual({ g1: "Group 1", g2: "Group 2" });
    expect(resolveGroupLabels({ g1: "Stent" })).toEqual({ g1: "Stent", g2: "Group 2" });
    expect(resolveGroupLabels({ g1: "", g2: "Sham" })).toEqual({ g1: "Group 1", g2: "Sham" });
  });
});

describe("formatting", () => {
  it("fmtValue keeps integers plain and trims decimals", () => {
    expect(fmtValue(12)).toBe("12");
    expect(fmtValue(4.5)).toBe("4.5");
    expect(fmtValue(120.004)).toBe("120");
    expect(fmtValue(null)).toBe("—");
    expect(fmtValue(Number.NaN)).toBe("—");
  });

  it("fmtCi renders the estimate with its interval", () => {
    expect(fmtCi({ estimate: 0.49, ciLow: 0.316, ciHigh: 0.758 })).toBe("0.49 [0.32, 0.76]");
  });

  it("fmtP floors tiny p-values", () => {
    expect(fmtP(0.0004)).toBe("<0.001");
    expect(fmtP(0.049)).toBe("0.049");
  });

  it("slugify produces a safe filename base", () => {
    expect(slugify("All-cause mortality (12 mo)")).toBe("all-cause-mortality-12-mo");
    expect(slugify("***")).toBe("outcome");
  });
});

describe("isBinaryMeasure", () => {
  it("splits binary from continuous measures", () => {
    expect(isBinaryMeasure("RR")).toBe(true);
    expect(isBinaryMeasure("RD")).toBe(true);
    expect(isBinaryMeasure("MD")).toBe(false);
    expect(isBinaryMeasure("SMD")).toBe(false);
  });
});

describe("apiErrorMessages", () => {
  it("flattens zod flatten() details", () => {
    const err = new ApiError("VALIDATION", "Invalid request", 400, {
      formErrors: ["mappings must be unique per role"],
      fieldErrors: { mappings: ["field is not a NUMBER field"] },
    });
    expect(apiErrorMessages(err)).toEqual([
      "mappings must be unique per role",
      "mappings: field is not a NUMBER field",
    ]);
  });

  it("reads message arrays and falls back to the top-level message", () => {
    const listErr = new ApiError("VALIDATION", "Invalid", 400, [{ message: "bad role" }, "nope"]);
    expect(apiErrorMessages(listErr)).toEqual(["bad role", "nope"]);
    const bare = new ApiError("FORBIDDEN", "No access", 403);
    expect(apiErrorMessages(bare)).toEqual(["No access"]);
    expect(apiErrorMessages(new Error("boom"))).toEqual(["boom"]);
  });
});

describe("hasCap", () => {
  it("mirrors the analysis rows of the permission matrix", () => {
    expect(hasCap(["OBSERVER"], "analysis.view")).toBe(true);
    expect(hasCap(["PANEL_MEMBER"], "analysis.view")).toBe(true);
    expect(hasCap(["OBSERVER"], "analysis.manage")).toBe(false);
    expect(hasCap(["STATISTICIAN"], "analysis.manage")).toBe(true);
    expect(hasCap(["REVIEWER"], "analysis.view")).toBe(false);
    expect(hasCap(null, "analysis.view")).toBe(false);
  });
});
