# Screening scope and assignment clarity

The guideline dashboard separates **screening scope** from PICO working-group membership.
Every screening entry names the configured combined PICOs or an individual PICO. Combined
entries use the saved pool; membership is resolved on the server. An individual entry stays
individual even when the guideline also has a pool. Stale explicit queue links require a new
selection, rather than silently selecting another scope. The displayed scope derives from the
reactive URL query, so sidebar navigation, explicit queue choices, Back/Forward, native history
changes, and reload resolve the same scope. Old pooled-PICO screening URLs lead
to the configured combined queue. Switching PICOs remounts the workspace so stage IDs,
permissions, notes, filters, and article state cannot carry over from the previous project.

## Protocol guidance

The read-only `GET /api/projects/:id/screening/scope?poolId=...` returns the current configured
protocol for each included project. It requires active organization/project membership and
`project.view` on every included PICO. Pool IDs are scoped to the guideline. It creates no
protocol rows and returns no decisions, invitation addresses, or co-reviewer content.

The scope panel displays populations, question definitions, eligibility criteria, study
designs, setting, date/language restrictions, and links to protocol versions and amendments.
Missing protocols, missing populations, and missing criteria are explicit. No disease,
population, study-design exception, deadline, personal target, or participant cutoff is
hard-coded. Displayed fields are explicitly the **current saved configuration**, which can
include unpublished edits. The latest immutable snapshot is separate `latestFrozenVersion`
metadata, labeled as a frozen protocol version; snapshots are created on publication or
amendment. A version number does not attribute the displayed live fields to that snapshot or
establish precedence. The timestamp is labeled **Core protocol fields updated** because PICO
and eligibility-criterion edits do not update the parent protocol row. Version/change history
must be consulted separately. Email proposals are not treated as approved amendments.

Combined guidance asks reviewers to assess relevance to **any included PICO**, checking all
configured criteria and exceptions. Article provenance describes where the record was
imported; it does not narrow the screening scope. The existing pooled decision still writes
atomically to every linked citation, preserving ordinary per-PICO decision keys. This is broad
screening, not a separate decision that establishes eligibility for every individual PICO.
Conflicting criteria or a need for question-specific decisions require a protocol/workflow
decision by the review lead. This change does not infer or modify that policy.

## Personal workload and admin inspection

Personal Target / Completed / Remaining are separate from available shared articles. A target
is never inferred from pool size or project membership. A missing target with no available
fixed assignment is distinct from an empty queue or a reached target. Unlimited targets remain
supported. Reviewers retain access to their own reviewed items.

Both individual and combined workspaces have **My screening** and a capability-gated
**Admin view**. In the combined Admin view, All abstracts and pool health are independent of
the manager's personal target. Screening buttons and decision shortcuts are disabled there.
Per-PICO conflict links point to the existing authorized adjudication workflow. No other
reviewer's vote or note is introduced into the projection.

Existing services retain the required independent-review count, no extra credit for revisions,
stale-write rejection, synchronization checks, and atomic result/conflict evaluation. After
the required reviews, disagreements leave Available but remain open for adjudicators.
Final outcomes lock decisions until authorized reopening.

## Invitation/account diagnostics

Invitation acceptance still uses normalized exact email equality. Different institutional
domains are separate accounts. Both invitation pages explain workspace membership, project
roles, and screening workload separately and offer an account-switch button that preserves
the invitation callback. The owner must resolve an incorrect invited address or role; this
change does not merge aliases, invite users, or expand permissions.

## Recovery design — separate authorization required

This feature does not reset or repair screening history. Start with a narrowly authorized
read-only assessment in the affected guideline and PICOs:

1. Verify the affected account, reported time window, configured current/historical pool
   membership, protocol versions/amendments, and personal target/fixed assignments. Read
   invitation and membership status only for the relevant accounts. Never collect tokens.
2. Join the account's decisions to stage/citation IDs and append-only audit history. Pooled
   decision audit metadata includes `pooledGuidelineId`, `pooledScreeningPoolId`, pool name,
   project IDs, and linked citation IDs. That establishes recorded write scope; it does not
   establish which browser label the reviewer saw or how they interpreted it. Do not invent
   route/context evidence when it was not logged.
3. Group logical abstracts separately from linked citation counts. Classify all reported
   decisions, including Include and Maybe, not just Exclude. Preserve original values,
   reasons, notes, timestamps, and the other reviewers' work in a private assessment. Compare
   linked assignments/decisions, conflicts/adjudications, and materialized stage results.
4. Identify downstream full-text, study, extraction, and other dependencies. Finalized
   adjudications and downstream work require explicit owner/adjudicator review. The existing
   individual reopen action is not a complete pooled recovery tool: it lacks a coordinated
   whole-group recovery and downstream-impact gate. Do not run it as an automatic batch reset.
5. For synchronized, unsettled records, an authorized reviewer can revise their own decision
   through the existing audited pooled path. The previous value remains in audit history;
   revisions do not earn another quota credit and reevaluate conflicts/results atomically.
   Confirm the correct scope first. A missing/divergent linked history requires a separate
   maintainer-designed, audited reconciliation; never copy a narrow-question vote into missing
   PICOs as an inferred broader judgment.
6. Before any approved recovery write, provide exact proposed records/counts and expected
   conflict/result/progress changes. Test the recovery on synthetic equivalents, require an
   unchanged-state preflight, preserve append-only audit history, and verify personal logical
   credit, shared availability, result counts, and downstream consistency afterward. Do not
   automatically reopen finalized adjudications or delete original decisions.

**Needs synchronization** is a fail-closed category, not a diagnosis: it includes missing or
partial decisions, completed markers without decisions, decisions without completed live
assignments, different reviewer sets/values/notes/reason labels, or mismatched results/open
conflicts. Unequal pending coverage alone is valid. A displayed count cannot determine which
cause applies; inspect authorized linked history privately before choosing a recovery.

## Verification

- Unit regressions cover explicit and stale entry links and actual noncontiguous pool labels.
- Integration regressions cover read-only protocol projection, PICO exceptions, missing
  protocols, pool scoping, restrictive roles, removed project/organization membership, and
  current saved fields remaining distinct from an immutable snapshot after unpublished edits.
- `npx playwright test --config playwright.assignment.config.ts` uses only
  `TEST_DATABASE_URL`: explicit individual entry, switching between individual PICOs,
  pooled/individual populations, keyboard expansion, mobile overflow, personal target versus
  shared availability, admin inspection without decision shortcuts, legacy pooled links,
  reviewer restrictions, stale scope, invitation mismatch/account switching, reactive
  sidebar/Back/Forward/reload scope, and draft-versus-frozen provenance with a narrowly labeled
  core timestamp.
- Existing pooled/quota suites cover distinct reviewers, revisions, stale pages, concurrent
  writes, final slots, conflicts, logical quota counting, exceptional linked histories,
  blinding, and rollback. Existing citation tests cover audited missing-abstract addition and
  invalidation of stale AI suggestions; saved screening notes already persist. Missing
  abstracts are not automatically excluded. The combined UI still has no inline metadata-gap
  editor; an authorized metadata manager can use the existing citation endpoint. Extending
  that UI is a separate follow-up.

No schema migration, production record change, merge, or deployment is part of this change.
