import { describe, expect, it } from "vitest";
import { can, capabilitiesFor, CAPABILITIES, type Capability } from "./matrix";
import type { ProjectRole } from "@prisma/client";

// Table-driven mirror of docs/05-permissions.md. If the matrix changes, change BOTH files.
const EXPECTED: Record<ProjectRole, Capability[] | "ALL"> = {
  OWNER: "ALL",
  ADMIN: "ALL",
  REVIEWER: ["project.view", "screening.decide", "audit.view"],
  ADJUDICATOR: [
    "project.view",
    "screening.decide",
    "screening.adjudicate",
    "fulltext.manage",
    "extraction.adjudicate",
    "rob.adjudicate",
    "analysis.view",
    "audit.view",
  ],
  EXTRACTOR: ["project.view", "fulltext.manage", "extraction.perform", "rob.assess", "audit.view"],
  STATISTICIAN: [
    "project.view",
    "extraction.templates",
    "extraction.perform",
    "rob.tools",
    "rob.assess",
    "analysis.view",
    "analysis.manage",
    "prisma.snapshot",
    "audit.view",
    "export.create",
  ],
  LIBRARIAN: [
    "project.view",
    "protocol.edit",
    "import.manage",
    "dedup.manage",
    "fulltext.manage",
    "prisma.snapshot",
    "audit.view",
    "export.create",
  ],
  PANEL_MEMBER: ["project.view", "analysis.view", "audit.view"],
  TRAINEE: ["project.view", "screening.decide", "fulltext.manage", "extraction.perform", "rob.assess"],
  OBSERVER: ["project.view", "analysis.view", "audit.view"],
};

describe("permission matrix", () => {
  for (const [role, expected] of Object.entries(EXPECTED) as [
    ProjectRole,
    Capability[] | "ALL",
  ][]) {
    it(`${role} has exactly the documented capabilities`, () => {
      const allowed = new Set(expected === "ALL" ? CAPABILITIES : expected);
      for (const cap of CAPABILITIES) {
        expect(can([role], cap), `${role} × ${cap}`).toBe(allowed.has(cap));
      }
    });
  }

  it("union of multiple roles grants the union of capabilities", () => {
    const caps = new Set(capabilitiesFor(["REVIEWER", "ADJUDICATOR"]));
    expect(caps.has("screening.adjudicate")).toBe(true);
    expect(caps.has("screening.decide")).toBe(true);
    expect(caps.has("project.members")).toBe(false);
  });

  it("no roles means no capabilities", () => {
    for (const cap of CAPABILITIES) expect(can([], cap)).toBe(false);
  });

  it("mutation capabilities are never granted to read-only roles", () => {
    const readOnly: ProjectRole[] = ["OBSERVER", "PANEL_MEMBER"];
    const mutating = CAPABILITIES.filter(
      (c) => c !== "project.view" && c !== "analysis.view" && c !== "audit.view",
    );
    for (const role of readOnly) {
      for (const cap of mutating) expect(can([role], cap), `${role} × ${cap}`).toBe(false);
    }
  });
});
