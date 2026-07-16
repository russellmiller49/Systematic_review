import { describe, expect, it } from "vitest";
import { parseSourceAnchor, sourceAnchorV2Schema, type SourceAnchorV2 } from "./source-anchor";

describe("parseSourceAnchor", () => {
  it("normalizes legacy v1 {fileId, page} to a page-only v2 anchor", () => {
    expect(parseSourceAnchor({ fileId: "f1", page: 3 })).toEqual({
      v: 2,
      fileId: "f1",
      page: 3,
      matchQuality: "page-only",
    });
  });

  it("returns null for legacy anchors without a usable page", () => {
    expect(parseSourceAnchor({ fileId: "f1", page: null })).toBeNull();
    expect(parseSourceAnchor({ fileId: "f1" })).toBeNull();
    expect(parseSourceAnchor({ fileId: "f1", page: 0 })).toBeNull();
    expect(parseSourceAnchor({ fileId: "f1", page: 2.5 })).toBeNull();
  });

  it("returns null for non-anchor values", () => {
    expect(parseSourceAnchor(null)).toBeNull();
    expect(parseSourceAnchor(undefined)).toBeNull();
    expect(parseSourceAnchor("x")).toBeNull();
    expect(parseSourceAnchor([1, 2])).toBeNull();
    expect(parseSourceAnchor({ page: 1 })).toBeNull(); // no fileId
    expect(parseSourceAnchor({ fileId: "", page: 1 })).toBeNull();
  });

  it("passes a full v2 anchor through", () => {
    const anchor: SourceAnchorV2 = {
      v: 2,
      fileId: "f1",
      page: 2,
      charStart: 10,
      charEnd: 42,
      matchQuality: "exact",
      matchScore: 1,
      textVersion: 3,
    };
    expect(parseSourceAnchor(anchor)).toEqual(anchor);
  });

  it("drops malformed optional fields but keeps the anchor", () => {
    expect(
      parseSourceAnchor({
        v: 2,
        fileId: "f1",
        page: 1,
        charStart: 10, // lone endpoint pair-mate is invalid
        charEnd: 5,
        matchScore: 7,
        textVersion: -1,
        matchQuality: "fuzzy",
      }),
    ).toEqual({ v: 2, fileId: "f1", page: 1, matchQuality: "fuzzy" });
  });

  it("rejects unknown versions and bad qualities", () => {
    expect(parseSourceAnchor({ v: 3, fileId: "f1", page: 1, matchQuality: "exact" })).toBeNull();
    expect(parseSourceAnchor({ v: 2, fileId: "f1", page: 1, matchQuality: "nope" })).toBeNull();
    expect(parseSourceAnchor({ v: 2, fileId: "f1", page: 1 })).toBeNull();
  });

  it("keeps well-formed quads and drops malformed ones", () => {
    const quads = [[1, 2, 3, 4, 5, 6, 7, 8]];
    expect(
      parseSourceAnchor({ v: 2, fileId: "f1", page: 1, matchQuality: "selection", quads }),
    ).toEqual({ v: 2, fileId: "f1", page: 1, matchQuality: "selection", quads });
    expect(
      parseSourceAnchor({
        v: 2,
        fileId: "f1",
        page: 1,
        matchQuality: "selection",
        quads: [[1, 2]],
      }),
    ).toEqual({ v: 2, fileId: "f1", page: 1, matchQuality: "selection" });
  });
});

describe("sourceAnchorV2Schema", () => {
  it("accepts a minimal page-only anchor and a full anchor", () => {
    expect(
      sourceAnchorV2Schema.safeParse({ v: 2, fileId: "f", page: 1, matchQuality: "page-only" })
        .success,
    ).toBe(true);
    expect(
      sourceAnchorV2Schema.safeParse({
        v: 2,
        fileId: "f",
        page: 4,
        charStart: 0,
        charEnd: 9,
        matchQuality: "selection",
        matchScore: 0.9,
        textVersion: 1,
      }).success,
    ).toBe(true);
  });

  it("rejects lone or inverted offset pairs", () => {
    expect(
      sourceAnchorV2Schema.safeParse({
        v: 2,
        fileId: "f",
        page: 1,
        charStart: 5,
        matchQuality: "exact",
      }).success,
    ).toBe(false);
    expect(
      sourceAnchorV2Schema.safeParse({
        v: 2,
        fileId: "f",
        page: 1,
        charStart: 9,
        charEnd: 5,
        matchQuality: "exact",
      }).success,
    ).toBe(false);
  });

  it("rejects legacy v1 input (clients must send v2)", () => {
    expect(sourceAnchorV2Schema.safeParse({ fileId: "f", page: 1 }).success).toBe(false);
    expect(sourceAnchorV2Schema.safeParse({ v: 2, fileId: "f", page: 0, matchQuality: "exact" }).success).toBe(false);
  });
});
