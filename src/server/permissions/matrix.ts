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
  "prisma.snapshot",
  "audit.view",
  "export.create",
] as const;

export type Capability = (typeof CAPABILITIES)[number];

const ALL: readonly Capability[] = CAPABILITIES;

const MATRIX: Record<ProjectRole, readonly Capability[]> = {
  OWNER: ALL,
  ADMIN: ALL,
  // A plain reviewer can make screening decisions only through the assignment-gated
  // screening service. Full-text administration belongs to admins/librarians or an
  // explicitly combined role.
  REVIEWER: ["project.view", "screening.decide", "audit.view"],
  ADJUDICATOR: [
    "project.view",
    "screening.decide",
    "screening.adjudicate",
    "fulltext.manage",
    "extraction.adjudicate",
    "rob.adjudicate",
    "audit.view",
  ],
  EXTRACTOR: ["project.view", "fulltext.manage", "extraction.perform", "rob.assess", "audit.view"],
  STATISTICIAN: [
    "project.view",
    "extraction.templates",
    "extraction.perform",
    "rob.tools",
    "rob.assess",
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
  PANEL_MEMBER: ["project.view", "audit.view"],
  TRAINEE: [
    "project.view",
    "screening.decide",
    "fulltext.manage",
    "extraction.perform",
    "rob.assess",
  ],
  OBSERVER: ["project.view", "audit.view"],
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
