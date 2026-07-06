# Frontend Route & Component Plan

## Route map (App Router)

```
/                                  Landing (marketing-lite) → redirects to /orgs when signed in
/sign-in, /sign-up                 Auth pages
/orgs                              Organization switcher / dashboard (projects across my orgs)
/orgs/[orgId]                      Org dashboard: projects grid, members, "new project" wizard
/projects/[projectId]              PROJECT DASHBOARD (stats, progress bars, recent activity)
/projects/[projectId]/protocol     Protocol editor (sectioned form + criteria/outcomes/PICO editors,
                                   versions & amendments tab)
/projects/[projectId]/import       Upload → parse preview table (per-row errors) → commit
/projects/[projectId]/dedup        Duplicate groups: side-by-side compare, evidence badges,
                                   merge / not-a-duplicate / undo
/projects/[projectId]/screening    Title/abstract screening workspace (queue + card + shortcuts)
/projects/[projectId]/conflicts    Adjudication dashboard (T/A + full-text tabs)
/projects/[projectId]/fulltext     Full-text stage: retrieval tracking, PDF upload/link, FT screening
/projects/[projectId]/extraction   Templates tab (builder) + Extract tab (study list → form)
/projects/[projectId]/rob          Tools tab (builder) + Assess tab (study list → domain form)
/projects/[projectId]/prisma       PRISMA dashboard (flow counts, per-source, per-reason, snapshot+export)
/projects/[projectId]/audit        Filterable audit table with before/after diff viewer
/projects/[projectId]/settings     Project settings, team & roles, invitations, exclusion reasons,
                                   exports
/invitations/[token]               Accept invitation
```

Layout: `(app)` group has top nav (org/project switcher, user menu); project pages share a
sidebar with workflow-ordered nav + per-section progress hints. Server components fetch
initial data; interactive workspaces (screening, dedup, forms) are client components calling the
REST API. Loading via `loading.tsx` skeletons; every list has a designed empty state; errors via
`error.tsx` + inline form errors.

## Component inventory (beyond ui/ primitives)

- **ui/** (owned, shadcn-style): button, input, textarea, label, select, checkbox, badge, card,
  dialog, dropdown-menu, table, tabs, toast, tooltip, progress, skeleton, alert, separator.
- **layout/**: `AppShell`, `ProjectSidebar`, `OrgSwitcher`, `UserMenu`, `PageHeader`,
  `EmptyState`, `ErrorState`, `StatCard`.
- **citations/**: `CitationCard` (title/authors/year/journal/abstract/identifiers/source/labels/
  notes — shared by screening, dedup, conflicts, fulltext), `AbstractClamp`, `IdentifierBadges`,
  `LabelPicker`.
- **import/**: `ImportDropzone`, `FormatBadge`, `PreviewTable` (row status + parse errors),
  `SourcePicker`, `CommitSummary`.
- **dedup/**: `DuplicateGroupList`, `PairCompare` (field-by-field diff highlight),
  `MatchEvidence` (why suggested: method + scores), `MergeDialog` (canonical picker).
- **screening/**: `ScreeningWorkspace` (queue state machine), `DecisionBar`
  (include/exclude/maybe + note + labels + flag), `KeyboardShortcuts` (i/e/m/n/u, arrows; help
  overlay on `?`), `ProgressStrip`, `MaybeReasonPopover`.
- **conflicts/**: `ConflictList`, `ConflictDetail` (all reviewer decisions + notes side by side,
  protocol criteria panel), `AdjudicationForm` (decision + required reason).
- **fulltext/**: `RetrievalStatusBadge`, `PdfUploadButton`, `RetrievalAttemptLog`,
  `FullTextDecisionBar` (exclude requires reason select).
- **extraction/**: `TemplateBuilder` (field list + drag order + type-specific option editors),
  `FieldEditor`, `ExtractionFormRenderer` (renders by field type),
  `ValueSourcePopover` (quote + page), `ExtractionConflictTable`.
- **rob/**: `RobToolBuilder` (domains → signaling questions), `RobAssessmentForm` (per-domain
  judgment + support + signaling answers), `JudgmentBadge` (traffic-light), `RobSummaryTable`
  (studies × domains grid).
- **prisma/**: `PrismaFlow` (structured count list mirroring PRISMA 2020 boxes — data shaped so a
  real diagram is a later drop-in), `SourceBreakdownTable`, `ExclusionReasonTable`,
  `SnapshotList`.
- **audit/**: `AuditTable`, `AuditFilters`, `DiffViewer` (previous vs new JSON).
- **settings/**: `MemberTable` (roles multi-select, soft-remove), `InviteDialog`,
  `ExclusionReasonManager`, `ExportPanel`.

## UX commitments

- Screening is keyboard-first: single-column card, decision persists optimistically, queue
  auto-advances; target < 2s per obvious decision.
- Blinding is respected in every component (the API never sends other reviewers' decisions while
  blinded — UI cannot leak what it never receives).
- Destructive/irreversible-looking actions (merge, adjudicate, publish protocol) get confirm
  dialogs that state the audit consequence, and merges are undoable.
