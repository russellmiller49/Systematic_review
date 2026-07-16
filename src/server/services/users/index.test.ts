import { describe, expect, it } from "vitest";
import { parsePilotEmailAllowlist } from "./index";

describe("parsePilotEmailAllowlist", () => {
  it("normalizes, trims, and deduplicates email addresses", () => {
    expect(
      [...parsePilotEmailAllowlist(" Owner@Example.com, reviewer@example.com, owner@example.com ")],
    ).toEqual(["owner@example.com", "reviewer@example.com"]);
  });

  it("treats an unset or blank value as open registration", () => {
    expect(parsePilotEmailAllowlist(undefined).size).toBe(0);
    expect(parsePilotEmailAllowlist(" , ").size).toBe(0);
  });
});
