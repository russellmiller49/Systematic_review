# Pooled title/abstract open review queue

A reviewer target specifies how many logical abstracts to screen. It never selects or
reserves particular abstracts. PICO 1 remains an independent title/abstract queue; the
saved guideline pool defines the combined queue (for example, PICO 2–6).

## Previous behavior and architecture

The previous backend already supported quota authorization without pending assignments,
including on-demand assignment creation and stage locks. Its pooled response stopped at
25 groups, and the UI always displayed `items[0]`. It had no arbitrary selection, search,
pagination, or review history. It also mixed finalized records with inconsistent linked
state and derived an assignment-health label from the current reviewer's assignments.
The pooled decision schema omitted Maybe.

The implementation retains existing quota, assignment, decision, conflict, stage-result,
and audit tables. `pooled-state.ts` bulk-loads narrow identity and screening state and
classifies logical groups. The navigator and the locked decision transaction use the
same eligibility classifier. Existing exact DOI/PMID/normalized-title grouping is retained.

The pooled and ordinary workspaces share `ArticleList` (through the ordinary
`ArticleNavigator` adapter), `ArticlePosition`, `DecisionControls`,
`useScreeningShortcuts`, `ExcludeDialog`, `ShortcutsDialog`, and `QuotaProgress`.
Pooled API types remain separate from ordinary citation/assignment API types.

## Authorization, availability, and history

Active organization and screening membership are required for the guideline and its
selected PICOs. A saved pooled quota with remaining work authorizes any eligible logical
abstract. If no quota exists, live legacy fixed assignments on every copy still authorize
that work. A quota, including target zero, takes precedence over pending fixed assignments.

Available groups have no prior decision by the current reviewer, spare independent review
capacity, no final result, no voided assignment for that reviewer, and consistent linked
screening state. Completed assignment/decision sets, each reviewer's decision, note and
exclusion label, stage outcomes, and open-conflict state must agree across copies. Unequal
pending assignment coverage alone is not a synchronization defect.

My reviewed remains accessible at the target and includes saved notes. Consistent,
unfinalized decisions can be revised under ordinary screening rules. Revisions count once
and preserve an omitted note; explicit null/empty notes clear it. Target increases take
effect on the next refresh. Reductions below completed work and zero targets never delete
work. Historical completed fixed reviews count once per logical group, including when a
new copy has made that group need synchronization. A COMPLETED assignment without a
matching decision receives no quota credit. This historical credit is separate from
admin finalized/fully-reviewed counts, which exclude synchronization exceptions.

## Navigation and decisions

`GET /api/projects/:guidelineId/screening/pooled` accepts `poolId`, `page`, `limit`
(default 50, maximum 100), `q`, and `status=AVAILABLE|MY_REVIEWED|ALL`.
ALL is restricted to Owner/Admin. Pagination operates on complete logical groups. Search
matches title, abstract, author JSON, DOI, or PMID on any copy; it never splits a group.
Only the current page's full citation text is hydrated and returned. A stable group ID
keeps selection independent of which linked citation supplies the richest abstract.

Click any navigator row, use previous/next, or J/K and arrow keys. Pooled arrow navigation
crosses page boundaries. The list scrolls to the selected row, including on mobile.
Opening, searching, changing pages, and skipping make no assignment, decision, or audit
writes. Include, Exclude, Maybe, notes, and quick-exclusion shortcuts share ordinary
controls. Found in lists every represented PICO. Each decision applies to every listed
citation ID. Active matching exclusion labels are still required throughout the pool.

Pooled AI scores are not introduced: the previous pooled workflow did not support them,
and independent PICO suggestions need an explicit aggregation policy. Ordinary AI,
keyword highlighting, abstract metadata editing, and batch exclusion remain available
in ordinary screening. Pooled decisions operate one logical abstract at a time.

## Atomicity and concurrency

Pooled writes acquire shared guards on the selected project and stage rows, then an
exclusive lock on the requesting reviewer's pooled quota row (if present), then exclusive
locks on the selected linked citation rows. IDs are sorted within each lock class.
Different reviewers on different abstracts can hold these guards concurrently. Imports
and deduplication take a conflicting project guard; configuration changes take conflicting
stage guards. The per-citation writer retains the shared guard without upgrading it.
After waiting, writes
recheck pool membership, current stage configuration, quota progress, exact requested
group membership, all linked screening state, previous reviewer participation, final
results, and independent review capacity. Screening membership is also rechecked.

Assignment creation, decision creation/revision, assignment completion, audit records,
and ordinary conflict/result evaluation execute in the same transaction. A later linked
write failure rolls back earlier linked writes and quota credit. Simultaneous requests
cannot take a third review slot or spend the same reviewer's last quota slot twice.
Duplicate submissions by a reviewer remain revisions and cannot create extra rows.

Pool configuration changes, quota changes, adjudication, and reopening use the relevant
stage locks as well. Ordinary title/abstract writes recheck pool ownership after locking
to avoid a partial write when an administrator has just added that PICO to a pool.
Navigator reads use a repeatable-read transaction so a concurrent pooled commit cannot
appear as partially synchronized state between bulk queries.

A lost review-slot race returns `INVALID_STATE` with “This abstract has just received all
required reviews. Choose another abstract.” The UI displays it and automatically reloads
the queue and quota. No losing assignment, decision, audit, or quota completion survives.

Maybe is enabled and uses the same `maybeGeneratesConflict` behavior as ordinary
screening. Pool stages must have matching reviewer counts and Maybe conflict settings.
Unanimous Maybe always creates conflicts; mixed Maybe creates conflicts only when the
setting requires it. Full review capacity is closed even when no final outcome exists.

## Administration and metrics

Reviewer quotas are the primary action. Fixed assignment controls are explicitly labeled
and placed under advanced pool health controls (and a separate fixed-assignment control
for ordinary screening). Existing fixed assignments are preserved.

Personal metrics are Target, Completed, Remaining, and Available to review. Pool health
is returned only to Owner/Admin and is independent of their personal quota/assignments:
unique abstracts, linked records, cross-PICO overlaps, finalized, all reviews submitted
but unresolved, needs additional reviews, unreviewed, and needs synchronization.
“Needs pooled assignment” and “settled or out of sync” have been removed.

Blinded navigator responses contain aggregate review counts and the requesting reviewer's
own decision/note. Other reviewers' identities, notes, and decisions are never returned,
even in the Owner/Admin All navigator. Existing final-outcome visibility is retained.

## Production-readiness review

The focused hardening pass found and fixed orphan-assignment quota credit, missing import
coordination, and five-second transaction expirations under 40-reviewer contention.
See [production-readiness evidence and decision gate](pooled-production-readiness.md)
for current validation, exact lock scope, measurements, repair steps, and limitations.

## Initial implementation validation (before hardening)

- Before changes: all 14 existing pooled/quota integration tests passed.
- Unit suite: 642 tests passed in 62 files, including pooled grouping and new query/Maybe/skip schema cases.
- Integration suite: 376 tests passed in 35 files. Eleven new open-queue tests cover all
  requested A–N scenarios, legacy compatibility, independent PICO 1, atomic audit failure,
  permission gates, search on nonrepresentative copies, and a realistic corpus size.
- Browser suite: ordinary sign-up/import/screen/export, ordinary and pooled quota management,
  and a dedicated pooled reviewer workflow. The pooled test clicks abstract 37 among 65,
  crosses pages, searches, skips without writes, records Maybe and notes on three copies,
  revises history, verifies quota credit, and recovers from a real final-slot race.
- Local scale check: 4,110 logical abstracts / 9,203 linked records; 50-row page about 95 ms,
  decision about 104 ms, and 151,885-byte response. These are local observations, not a
  production throughput guarantee. No new index was justified by this measurement.
- Final browser rerun: all 3 tests passed after the page-boundary and mobile-height fixes;
  desktop and mobile screenshots were visually inspected.
- `npm run typecheck`, `npm run build`, Prettier 3.6.2 checks on all changed source/tests/docs,
  and `git diff --check` passed. The build explicitly reports that linting is skipped.
- No standalone lint script or ESLint configuration exists in the repository;
  `npm run lint` reports a missing script. No lint pass is claimed.

## Migration, compatibility, and limits

No Prisma schema change, database migration, assignment backfill, decision rewrite, or
history deletion is needed. Existing quota records continue to work. The pooled GET
response deliberately replaces the old summary categories with personal `summary`,
`adminSummary`, and pagination; bundled UI consumers are updated together.

Synchronization repair remains an administrative task. For example, independently
adjudicating/reopening only one linked PICO, or importing a new matching copy after review,
can temporarily require synchronization. Those abstracts are explicitly unavailable
rather than accepting a partial pooled write. This change does not add a bulk repair tool
or change existing exact grouping rules. Concurrent imports wait for active pooled review
guards before extending the corpus; subsequently imported copies are classified on the
next request and may correctly require synchronization.

Shared project/stage guards still let administrative or corpus mutations temporarily
block the pool. Exclusive decision locks cover only one reviewer quota and the selected
linked citation records. The new contention test checks 40 simultaneous local submissions;
it does not establish sustained production throughput. Persisted logical identities and
further query tuning remain follow-ups if corpus size or measured latency requires them.

## Changed files

- Backend: `src/server/services/screening/pooled.ts`, new `pooled-state.ts`, `quotas.ts`,
  `index.ts`, new `pooled-locks.ts`, `src/server/services/imports/index.ts`, and `src/app/api/projects/[projectId]/screening/pooled/route.ts`.
- Shared UI: `article-navigator.tsx`, new `article-position.tsx`, `decision-controls.tsx`,
  and `use-screening-shortcuts.ts` under `src/components/screening/`.
- Workspaces and administration in that same UI directory: `stage-queue.tsx`,
  `pooled-screening-workspace.tsx`, `screening-workspace.tsx`, `types.ts`,
  `quota-assignments-dialog.tsx`, and `pooled-assign-dialog.tsx`.
- Tests: `src/server/services/screening/pooled.test.ts`,
  `tests/integration/pooled-screening.test.ts`, new `tests/integration/pooled-open-queue.test.ts`,
  new `e2e/pooled-open-queue.spec.ts`, `e2e/screening-quotas.spec.ts`,
  `e2e/happy-path.spec.ts`, and `playwright.quota.config.ts`.
- Hardening tests: `tests/fixtures/pooled-readiness.ts`,
  `tests/integration/pooled-readiness.test.ts`, `tests/integration/pooled-contention.test.ts`;
  expanded `e2e/pooled-open-queue.spec.ts` also exercises independent PICO 1.
- Documentation: `README.md`, this report, and `docs/pooled-production-readiness.md`.
