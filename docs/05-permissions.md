# Permission Model

## Design

- **Capabilities, not role checks.** Code never asks "is admin?"; it asks
  `requirePermission(userId, projectId, 'screening.adjudicate')`. Roles map to capability sets in
  one matrix (`src/server/permissions/matrix.ts`). Adding a role or capability touches one file.
- **Server-side only enforcement.** Every service mutation starts with a permission check; UI
  hides what you can't do purely as a courtesy. API tests assert 403s.
- **Multiple roles per member** (`ProjectMember.roles: ProjectRole[]`): effective capabilities =
  union. A removed member (`status=REMOVED`) has **no** capabilities but their historical work
  remains attributed.
- Org roles are simpler: every ACTIVE `OWNER|ADMIN|MEMBER` may create organizations and projects;
  a project creator becomes that project's `OWNER`. `OWNER|ADMIN` additionally manage the
  organization's members and invitations. Org OWNER/ADMIN do **not** implicitly bypass project
  permissions (a librarian-run org must not let org admins alter screening data); access to an
  existing project still requires explicit project membership.

## Capability matrix

Capabilities: `project.view`, `project.edit`, `project.members`, `protocol.edit`,
`import.manage`, `dedup.manage`, `screening.decide`, `screening.adjudicate`,
`screening.configure`, `fulltext.manage` (upload/link/retrieval), `extraction.templates`,
`extraction.perform`, `extraction.adjudicate`, `rob.tools`, `rob.assess`, `rob.adjudicate`,
`analysis.view`, `analysis.manage`, `prisma.snapshot`, `audit.view`, `export.create`.

| Role \ Capability | view | edit | members | protocol | import | dedup | screen | adjudicate | scr.config | fulltext | ext.tmpl | extract | ext.adj | rob.tools | rob | rob.adj | analysis | analysis.manage | prisma | audit | export |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| OWNER | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| ADMIN | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| REVIEWER | ✅ | — | — | — | — | — | ✅ | — | — | — | — | — | — | — | — | — | — | — | — | ✅ | — |
| ADJUDICATOR | ✅ | — | — | — | — | — | ✅ | ✅ | — | ✅ | — | — | ✅ | — | — | ✅ | ✅ | — | — | ✅ | — |
| EXTRACTOR | ✅ | — | — | — | — | — | — | — | — | ✅ | — | ✅ | — | — | ✅ | — | — | — | — | ✅ | — |
| STATISTICIAN | ✅ | — | — | — | — | — | — | — | — | — | ✅ | ✅ | — | ✅ | ✅ | — | ✅ | ✅ | ✅ | ✅ | ✅ |
| LIBRARIAN | ✅ | — | — | ✅ | ✅ | ✅ | — | — | — | ✅ | — | — | — | — | — | — | — | — | ✅ | ✅ | ✅ |
| PANEL_MEMBER | ✅ | — | — | — | — | — | — | — | — | — | — | — | — | — | — | — | ✅ | — | — | ✅ | — |
| TRAINEE | ✅ | — | — | — | — | — | ✅* | — | — | ✅ | — | ✅* | — | — | ✅* | — | — | — | — | — | — |
| OBSERVER | ✅ | — | — | — | — | — | — | — | — | — | — | — | — | — | — | — | ✅ | — | — | ✅ | — |

\* TRAINEE acts like REVIEWER/EXTRACTOR/ROB-assessor but their stage participation is expected to
be supervised (workflow convention; same capabilities as the corresponding worker role — the
matrix exists so this can be tightened, e.g. "trainee decisions always dual-screened").

Additional invariants enforced in services, beyond the matrix:

- You can only create/update **your own** screening decisions, extraction forms, and RoB
  assessments (`reviewerId`/`extractorId`/`assessorId` always come from the session).
- A REVIEWER can decide only citation-stage pairs currently assigned to them. Assignment creation,
  workload inspection, and reset controls require `screening.configure` (OWNER/ADMIN).
- Assignment resets require an audit reason and remove only PENDING rows with no saved decision;
  completed assignments, decisions, conflicts, and stage results are preserved.
- Adjudicating your own two-way conflict is refused when the adjudicator is one of the
  conflicting reviewers **and** another eligible adjudicator exists (warn-and-allow with audit
  note otherwise — small teams are real).
- Blinded reads: `screening.decide` grants access to *your* decisions; others' decisions require
  the citation to be fully screened + stage unblinded, or `screening.adjudicate`.
- `project.members`: role changes and removals always write audit events with previous/new roles.
- GRADE audit rows require current `analysis.view` (or `project.edit`), even for a former actor;
  GRADE/ANALYSIS exports require both `export.create` and `analysis.view`.
- OBSERVER/PANEL_MEMBER are read-only everywhere by construction (no mutation capability).

## Mechanics

```ts
requirePermission(ctx, projectId, cap)   // throws ForbiddenError
getMembership(userId, projectId)         // cached per-request; ACTIVE members only
can(roles: ProjectRole[], cap): boolean  // pure, unit-tested against the matrix table above
```

Session context (`ctx`) = `{ userId }` from Auth.js JWT. Services take `ctx` as the first
argument; nothing trusts client-supplied user IDs.
