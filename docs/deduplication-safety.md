# Duplicate clusters and merge safety

A candidate is a **pairwise possible duplicate relationship**, not a confirmed publication
identity. An OPEN group is exactly one connected component of CURRENT SUGGESTED relationships
between ACTIVE citations in the same project. Active singletons have no open duplicate group.
Connectivity permits transitive duplicates but does not establish bibliographic truth.

Previously, rejecting a bridge left disconnected pairs in one stored group. Merge collected
all remaining endpoints and could mark distinct publications as duplicates of one canonical.
Now rejection and repartitioning commit together. The next frontend refresh displays separate
cards, each with its own canonical selection, without running detection again.

## Shared normalization

`dedup/groups.ts` rebuilds the graph using the pure `connectedComponents` helper. Detection,
rejection, undo, import rollback, bulk merging, and group listing use this service. Listing
repairs legacy grouping data on refresh, including groups left inconsistent before this fix.
Normalization reuses each project-owned group ID at most once; split components get additional
IDs. It moves only SUGGESTED rows, resolves unused OPEN groups, and retains historical groups
for audit/undo references. REJECTED/MERGED/COMPANION decisions, decision attribution, and timestamps are
not changed by normalization. Inapplicable suggestions (inactive or foreign endpoints) lose
group membership but retain their status; eligible suggestions can rejoin after undo.
Repeated normalization leaves already correct membership unchanged.

All dedup operations take a transaction-scoped lock on the project before reading the graph.
Import rollback uses the same lock and normalizes after removing citations/edges. This
serializes graph operations, including concurrent rejections and merge versus rejection.

## Merge invariant

Before any citation, assignment, conflict, or audit writes, merge requires:

- Exactly one connected component of SUGGESTED pairs in the requested OPEN group.
- Every endpoint is ACTIVE and belongs to the requested project; no self-pairs.
- The canonical citation belongs to that component.
- No applicable SUGGESTED edge touching a member is assigned outside this group.

Invalid membership fails with `INVALID_STATE` and no partial writes. The client refreshes;
group listing repairs the topology before the next manual merge. Bulk merge normalizes first
and invokes this same guarded merge separately for every eligible component.

Source records, identifiers, screening decisions, and citation metadata stay on their original
records. Merge sets `DUPLICATE`/`duplicateOfId`, voids pending assignments/open screening
conflicts, and records restoration IDs in audit metadata. Undo restores the citation and
recorded work, reopens its MERGED pairs, and normalizes against ACTIVE endpoints. Partial undo
of a transitive cluster does not create open groups through citations still marked DUPLICATE.
PRISMA continues to count citations with status DUPLICATE.

## Metadata conflicts and exact DOI bulk merge

Conflict state is derived from current imported fields on every listing and bulk eligibility
check; there is no schema change, identifier correction, or external bibliographic lookup.
Warnings apply when normalized identifiers show:

- Same non-null DOI with two different non-null PMIDs.
- Same non-null PMID with two different non-null DOIs.
- Shared DOI or PMID plus **all** of: titles at least 20 characters with Jaro–Winkler similarity
  below 0.70, nonempty author family-name sets with zero overlap, and known years over one year
  apart. This deliberately conservative rule does not flag missing data or year-only variation.

Cluster checks compare every pair of current members, including nonadjacent members, so a
record missing a PMID cannot hide disagreement between the cluster's other records. The UI
keeps the match method but replaces unqualified green match scores with manual-review warnings
for conflicts. Canonical controls have citation-specific accessible labels and reset when
suggested membership changes.

The server supplies bulk eligibility to the UI and recalculates it on execution. Only connected,
ACTIVE, single-DOI groups containing solely exact DOI suggestions, no historical rejected pair or direct companion judgment between merge members,
and no metadata conflicts qualify. Canonical preference remains screening-history count,
metadata completeness, oldest import, then citation ID. Historical rejected pairs conservatively
exclude their retained group from bulk merge even if a split moved the other endpoint away.
Manual review/merge remains possible for conflicting records; no metadata is silently changed.

## Abstract and publication-type comparison

Each pair has a keyboard-accessible **Compare abstracts** disclosure showing both complete
imported abstracts side by side. Empty abstracts are explicitly labeled as unavailable.

Publication type and import source appear in the comparison. Publication types are preserved
in source-record parsed JSON from RIS TY/M3/PT, NBIB PT, BibTeX entry/type fields, and CSV
publication/document/reference-type columns. Existing RIS, NBIB, and BibTeX records are
interpreted from their preserved raw record when parsed type metadata is absent. Legacy CSV
rows do not contain their headers, so their type remains unknown until reimported with a
supported type column. No database migration is required.

A conference type paired with an explicit journal article type produces a **possible conference
abstract and full publication** notice. Conference metadata takes precedence over generic JOUR
tags. Abstract length, PMID presence, and words in the title/abstract are not publication-type
evidence. Sources are displayed using the original import-source names, including PubMed and
Embase when those are the selected sources. This compares imported records only; it neither
searches external databases nor verifies full-text availability or study identity. Reviewers can
retain separate reports using **Same study / separate report**, preserving the study relationship.
Use **Not a duplicate** when no same-study relationship is intended.

Any connected group containing both conference and journal types is excluded from bulk exact
DOI merging, including when those members are not adjacent in the candidate graph. Eligibility
is recalculated server-side at execution; manual review remains available.

## Limits requiring reviewer judgment

A false relationship that remains SUGGESTED can still connect distinct publications. Reject
all false connecting relationships before merging. Rejecting one edge of a cycle may leave the
component connected; manual merge applies to the remaining connected component. Conflict
warnings do not determine which imported identifier is correct. Verify those records manually.
This change does not reverse historical merges automatically.

## Regression coverage

`dedup-topology.test.ts` covers requested cases A–I, both canonical choices, immediate splits,
singletons, malformed/stale groups, rejection persistence, nonadjacent conflicts, the five-record
wrong-DOI example, partial undo, idempotence, tenant corruption, and concurrent rejection.
Existing integration tests protect provenance, audit, screening work, bulk canonical choice,
permissions, import rollback, and PRISMA semantics. Pure tests cover graph topology and conflict
thresholds. `e2e/dedup-safety.spec.ts` verifies real rejection refresh, independent canonical
controls, conflict warnings, bulk exclusion, and an isolated merge in Chromium.

Run feature browser QA with `npx playwright test --config playwright.dedup.config.ts` after
integration tests (both use TEST_DATABASE_URL; don't run them concurrently).

Validation on this branch: 628 unit tests and 360 integration tests passed. The focused
42-test dedup/import suite also passed after the final project-lock adjustment, as did the
Chromium feature test (including hydration/runtime-error assertions), TypeScript, production
build, scoped Prettier checks, and `git diff --check`. The repository has no lint script or
ESLint configuration; Next.js explicitly skips linting. The full browser suite was not run.

## Same study / separate report

Three review outcomes have different meanings:

| Decision                     | Meaning                                                               | Citation effect                                                                  | Study effect                                                            |
| ---------------------------- | --------------------------------------------------------------------- | -------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| Merge                        | Same publication imported more than once                              | Canonical stays ACTIVE; copies become DUPLICATE                                  | Existing linked duplicates require reconciliation first                 |
| Not a duplicate              | No confirmed shared study                                             | Both remain ACTIVE; pair becomes REJECTED                                        | None                                                                    |
| Same study / separate report | Human-confirmed different publications of one underlying study/cohort | Both remain ACTIVE, metadata and duplicateOfId unchanged; pair becomes COMPANION | Link only ACTIVE full-text INCLUDED reports through the study lifecycle |

Migration `20260920150000_dedup_companion` adds only the `COMPANION` enum value. The existing
candidate stores original pair IDs, reviewer and timestamp; `dedup.companion_confirmed` records
project, pair, previous/new status, and actor. Comparing abstracts never creates audit events.
Only SUGGESTED edges participate in normalization. Removing a companion bridge immediately
splits the duplicate graph; removing an edge of a cycle can leave a connected component, but
manual and bulk merges refuse any explicit COMPANION edge whose two distinct canonical roots
are both merge members. Shared companion-component membership through external reports does
not block true duplicate copies. This is deliberately different from transitive same-study
membership, which still governs full-text reconciliation. Exact-DOI eligibility ignores
external companion rows retained in a historical group, while retaining all other review rules.
Historical endpoints never change: `duplicateOfId` chains project them to current canonicals.
Detection never overwrites decided pairs and does not invent new duplicate suggestions for
already confirmed companion components after a canonical replacement.

The group action explicitly confirms the visible list of suggested pair IDs. It keeps every
citation active, records each current suggested pair, and resolves that cluster. A stale list
is rejected atomically. Mixed clusters require pair classification first so actual imported
copies can still be merged separately. The Resolved tab lists decisions even if their original
group still has open suggestions; labels distinguish all three outcomes.

### Inclusion, reconciliation and undo

See [companion-report lifecycle](companion-reports.md). No Study or StudyReportLink is created
for a pre-inclusion judgment. Normal full-text INCLUDE settlement checks the confirmed component,
creates the first study, and links subsequent eligible reports to it. Excluded/unscreened nodes
can transmit the known cohort relationship but receive no analysis link. Existing primary
selection is retained; a later journal report never silently replaces it.

The project transaction lock serializes companion decisions, dedup merges, full-text settlement,
and study membership changes. Full-text writes acquire it before stage/assignment locks.
Both simultaneous includes and a decision racing with inclusion converge on one study. Multiple
existing studies use the same guarded merge as the cohort service: a source with extraction,
RoB, AI, analysis exclusions, synthesis membership, or notes blocks the whole operation. Report
moves and study merges have distinct audit events. There is no automatic destruction of work.

**Reopen decision** restores an early COMPANION or REJECTED pair to SUGGESTED and normalizes.
After linkage has used the judgment, a durable `dedup.companion_applied` audit marker prevents
reopening; existing multiple study links also block. No automatic unlink/split occurs. Restore
merged records before revising their original pair. Downstream corrections require deliberate
study reconciliation; this feature does not add a destructive study-splitting tool.

Companion decisions require `dedup.manage`. If eligible reports require immediate study
reconciliation during confirmation, `project.edit` is also required; otherwise that transaction
rolls back with no decision saved. Later inclusion retains the established reviewer-triggered
study lifecycle. Algorithmic cohort detection and manual study management retain `project.edit`.

### Added regression coverage

`dedup-companion.test.ts` covers outcomes A–N, the five-report UCL-style fixture, excluded
intermediate reports, simultaneous inclusion, original-pair provenance after citation merges,
manual API bypass protection, tenancy, permissions, stale confirmations, audit and PRISMA.
Pure companion projection tests cover canonical chains, transitivity and corrupt cycles.
`e2e/dedup-companion.spec.ts` exercises pair/reopen/group review, companion visibility and the
real inclusion API; `playwright.companion.config.ts` runs it with the existing dedup and cohort
browser tests against TEST_DATABASE_URL. Do not run this alongside integration tests.

Companion feature validation: 664 unit tests, 401 integration tests, and all 4 Chromium feature
tests passed. Typecheck, Prisma schema validation, production build, scoped Prettier checks,
and `git diff --check` passed. The enum migration was applied to the integration database.
The full unrelated browser suite was not run.

The merge-guard regression covers duplicate copies joining two companion families and copies
already sharing one family, through both manual and exact-DOI bulk merge. It checks immutable
human rows, direct and multi-hop historical conflict blocking, canonical projection, detection
reruns, and full-text inclusion yielding three report links on one Study with correct PRISMA
counts. Browser coverage checks the explicit-conflict error, then selects the PubMed canonical
and merges the remaining Embase copy before including the three surviving reports.

Merge-guard correction validation: 54 focused unit tests, 98 integration tests across dedup,
companion, cohort, screening and full-text suites, and all 5 companion/dedup safety/cohort
browser tests passed. Typecheck, production build, scoped Prettier and `git diff --check`
passed. No new migration was added; integration and browser checks used TEST_DATABASE_URL.
The unrelated full suites were not rerun. Detection retains its existing conservative
suppression of new suggestions within companion families; existing unresolved duplicate
suggestions remain reviewable. Missing-root/cycle handling and downstream reopening limits
are unchanged.
