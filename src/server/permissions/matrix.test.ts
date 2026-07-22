import { describe, expect, it } from "vitest";
import { can, capabilitiesFor, CAPABILITIES, type Capability } from "./matrix";
import type { ProjectRole } from "@prisma/client";

// Table-driven mirror of docs/05-permissions.md. If the matrix changes, change BOTH files.
const EXPECTED: Record<ProjectRole, Capability[] | "ALL"> = {
  OWNER: "ALL",
  ADMIN: "ALL",
  REVIEWER: [
    "project.view",
    "screening.decide",
    "audit.view",
    "references.view",
    "manuscript.view",
    "manuscript.comment",
    "chat.participate",
  ],
  ADJUDICATOR: [
    "project.view",
    "screening.decide",
    "screening.adjudicate",
    "fulltext.manage",
    "extraction.adjudicate",
    "rob.adjudicate",
    "analysis.view",
    "audit.view",
    "references.view",
    "manuscript.view",
    "manuscript.edit",
    "manuscript.comment",
    "chat.participate",
  ],
  EXTRACTOR: [
    "project.view",
    "fulltext.manage",
    "extraction.perform",
    "rob.assess",
    "audit.view",
    "references.view",
    "manuscript.view",
    "manuscript.comment",
    "chat.participate",
  ],
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
    "references.view",
    "references.manage",
    "manuscript.view",
    "manuscript.edit",
    "manuscript.comment",
    "chat.participate",
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
    "references.view",
    "references.manage",
    "manuscript.view",
    "manuscript.edit",
    "manuscript.comment",
    "chat.participate",
  ],
  PANEL_MEMBER: [
    "project.view",
    "analysis.view",
    "audit.view",
    "references.view",
    "manuscript.view",
    "manuscript.comment",
    "chat.participate",
  ],
  TRAINEE: [
    "project.view",
    "screening.decide",
    "fulltext.manage",
    "extraction.perform",
    "rob.assess",
    "references.view",
    "manuscript.view",
    "manuscript.comment",
    "chat.participate",
  ],
  OBSERVER: [
    "project.view",
    "analysis.view",
    "audit.view",
    "references.view",
    "manuscript.view",
    "chat.participate",
  ],
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
    const readCaps = new Set([
      "project.view",
      "analysis.view",
      "audit.view",
      "references.view",
      "manuscript.view",
    ]);
    // chat.participate is communication, not domain work product — every role has it.
    const mutating = CAPABILITIES.filter((c) => !readCaps.has(c) && c !== "chat.participate");
    // OBSERVER is otherwise strictly read-only.
    for (const cap of mutating) expect(can(["OBSERVER"], cap), `OBSERVER × ${cap}`).toBe(false);
    // PANEL_MEMBER is read-only EXCEPT manuscript comments — feedback is their whole job.
    for (const cap of mutating.filter((c) => c !== "manuscript.comment")) {
      expect(can(["PANEL_MEMBER"], cap), `PANEL_MEMBER × ${cap}`).toBe(false);
    }
  });
});
