// Unit tests for the GRADE presentation helpers added to the analysis types module.

import { describe, expect, it } from "vitest";
import {
  CERTAINTY_META,
  DOMAIN_LABELS,
  DOMAIN_ORDER,
  JUDGMENT_META,
  ORIGIN_LABELS,
  pointsArithmetic,
  sofCertaintyPresentation,
  superscriptMarker,
} from "./types";

describe("pointsArithmetic", () => {
  it("renders the summary line from the contract example", () => {
    expect(pointsArithmetic("HIGH", 3, "MODERATE")).toBe("Started HIGH (4) − 1 = 3 → Moderate");
  });

  it("handles zero deductions and both starting levels", () => {
    expect(pointsArithmetic("HIGH", 4, "HIGH")).toBe("Started HIGH (4) − 0 = 4 → High");
    expect(pointsArithmetic("LOW", 2, "LOW")).toBe("Started LOW (2) − 0 = 2 → Low");
    expect(pointsArithmetic("LOW", 1, "VERY_LOW")).toBe("Started LOW (2) − 1 = 1 → Very low");
  });

  it("shows the effective deduction after the >= 1 floor", () => {
    // Three SERIOUS + one VERY_SERIOUS would be -5, but points clamp at 1: display -3.
    expect(pointsArithmetic("HIGH", 1, "VERY_LOW")).toBe("Started HIGH (4) − 3 = 1 → Very low");
  });
});

describe("superscriptMarker", () => {
  it("maps digits to unicode superscripts", () => {
    expect(superscriptMarker(1)).toBe("¹");
    expect(superscriptMarker(3)).toBe("³");
    expect(superscriptMarker(10)).toBe("¹⁰");
    expect(superscriptMarker(12)).toBe("¹²");
  });
});

describe("sofCertaintyPresentation", () => {
  const base = {
    level: "MODERATE" as const,
    points: 3,
    status: "REVIEWED" as const,
    startingLevel: "HIGH" as const,
    reviewedByName: "Ada Reviewer",
  };

  it("does not present changed results as reviewed/current", () => {
    expect(
      sofCertaintyPresentation({ ...base, stale: true, sourceUnavailable: false }),
    ).toEqual({
      certaintyText: "Moderate (out of date)",
      statusText: "Out of date",
      detail: "Evidence or protocol context changed; regenerate GRADE before using this saved certainty.",
      outOfDate: true,
    });
  });

  it("names a missing pooled source explicitly", () => {
    expect(
      sofCertaintyPresentation({ ...base, stale: false, sourceUnavailable: true }),
    ).toEqual({
      certaintyText: "Moderate (out of date)",
      statusText: "Source unavailable",
      detail:
        "No study currently contributes to the pooled result; this saved certainty is out of date.",
      outOfDate: true,
    });
  });

  it("keeps a fresh reviewed assessment reviewed", () => {
    expect(
      sofCertaintyPresentation({ ...base, stale: false, sourceUnavailable: false }),
    ).toEqual({
      certaintyText: "Moderate",
      statusText: "Reviewed",
      detail: null,
      outOfDate: false,
    });
  });
});

describe("GRADE presentation metadata", () => {
  it("orders the five domains canonically and labels each", () => {
    expect(DOMAIN_ORDER).toEqual([
      "RISK_OF_BIAS",
      "INCONSISTENCY",
      "INDIRECTNESS",
      "IMPRECISION",
      "PUBLICATION_BIAS",
    ]);
    for (const domain of DOMAIN_ORDER) {
      expect(DOMAIN_LABELS[domain].length).toBeGreaterThan(0);
    }
  });

  it("uses the four-symbol plus/circle notation per certainty level", () => {
    expect(CERTAINTY_META.HIGH.symbols).toBe("⊕⊕⊕⊕");
    expect(CERTAINTY_META.MODERATE.symbols).toBe("⊕⊕⊕◯");
    expect(CERTAINTY_META.LOW.symbols).toBe("⊕⊕◯◯");
    expect(CERTAINTY_META.VERY_LOW.symbols).toBe("⊕◯◯◯");
    for (const meta of Object.values(CERTAINTY_META)) {
      expect(meta.symbols).toHaveLength(4);
      expect(meta.colorClass.length).toBeGreaterThan(0);
    }
  });

  it("maps judgments to labels and traffic-light badge variants", () => {
    expect(JUDGMENT_META.NOT_SERIOUS).toEqual({ label: "Not serious", variant: "include" });
    expect(JUDGMENT_META.SERIOUS).toEqual({ label: "Serious", variant: "maybe" });
    expect(JUDGMENT_META.VERY_SERIOUS).toEqual({ label: "Very serious", variant: "exclude" });
  });

  it("labels rating origins", () => {
    expect(ORIGIN_LABELS.AUTO).toBe("Auto");
    expect(ORIGIN_LABELS.HUMAN).toBe("Edited");
    expect(ORIGIN_LABELS.AI_APPLIED).toBe("AI-assisted");
  });
});
