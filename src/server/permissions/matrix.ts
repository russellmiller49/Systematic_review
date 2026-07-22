import type { ProjectRole } from "@prisma/client";

// Capability catalog. Code asks "can(roles, capability)" — never "is admin?".
// The authoritative human-readable matrix lives in docs/05-permissions.md; this file is it, in code.

export const CAPABILITIES = [
  "project.view",
  "project.edit",
  "project.members",
  "protocol.edit",
  "import.manage",
  "dedup.manage",
  "screening.decide",
  "screening.adjudicate",
  "screening.configure",
  "fulltext.manage",
  "extraction.templates",
  "extraction.perform",
  "extraction.adjudicate",
  "rob.tools",
  "rob.assess",
  "rob.adjudicate",
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
  "manuscript.manage",
  "chat.participate",
  "chat.manage",
  "chat.assign",
] as const;

export type Capability = (typeof CAPABILITIES)[number];

const ALL: readonly Capability[] = CAPABILITIES;

const MATRIX: Record<ProjectRole, readonly Capability[]> = {
  OWNER: ALL,
  ADMIN: ALL,
  // A plain reviewer can make screening decisions only through the assignment-gated
  // screening service. Full-text administration belongs to admins/librarians or an
  // explicitly combined role.
  // manuscript.view is universal; manuscript.edit (any section) belongs to senior
  // drafting roles — everyone else edits only sections ASSIGNED to them (the service's
  // canEditSection helper, mirroring assignment-gated screening). manuscript.comment is
  // everyone except OBSERVER. manuscript.manage (structure/assignment/approval) is
  // OWNER/ADMIN only (via ALL).
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

const ROLE_SETS = Object.fromEntries(
  Object.entries(MATRIX).map(([role, caps]) => [role, new Set(caps)]),
) as unknown as Record<ProjectRole, ReadonlySet<Capability>>;

export function can(roles: readonly ProjectRole[], capability: Capability): boolean {
  return roles.some((role) => ROLE_SETS[role].has(capability));
}

export function capabilitiesFor(roles: readonly ProjectRole[]): Capability[] {
  const set = new Set<Capability>();
  for (const role of roles) for (const cap of ROLE_SETS[role]) set.add(cap);
  return [...set];
}
