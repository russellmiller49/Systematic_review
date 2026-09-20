# Pooled queue: production-readiness review

Branch: `codex/pooled-open-review-queue`. PR: [#11](https://github.com/russellmiller49/Systematic_review/pull/11).
This review uses synthetic records in the isolated test database. It does not inspect or
repair the deployed screening corpus. No pooled AI or automatic repair was added.

## Findings and decision gate

| Priority                | Finding                                                                                                                                                                | Disposition                                                                                                                                                                                                   |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| BLOCKER                 | Quota accounting trusted legacy COMPLETED assignments without a matching human decision. Orphan markers could exhaust a target.                                        | Fixed: completed credit joins assignment and decision on reviewer, citation, and stage; pooled identities count each reviewer once.                                                                           |
| BLOCKER                 | Import commit did not participate in corpus locking. A matching citation could be inserted after a pooled write resolved its linked identities.                        | Fixed: import commit takes the same project guard as deduplication. A controlled real-import test verifies it waits for the active pooled transaction, then its new copy fails closed on the next queue read. |
| SHOULD FIX BEFORE MERGE | Exclusive locks on every project/stage serialized unrelated reviews. The realistic burst produced 11 unrelated-submission and 7 same-abstract transaction expirations. | Fixed: shared project/stage guards plus exclusive reviewer-quota and linked-citation locks; no timeout increase.                                                                                              |
| SHOULD FIX BEFORE MERGE | Writes loaded the entire pool's screening state and repeated identity grouping for quota calculation.                                                                  | Fixed: one identity scan/grouping per request; writes load detailed state only for the selected group. Stale full groups reject before quota counting.                                                        |
| FOLLOW-UP               | No automated synchronization reconciliation.                                                                                                                           | Remains deliberately manual and fail closed; current administrative steps below.                                                                                                                              |
| FOLLOW-UP               | No pooled AI aggregation.                                                                                                                                              | Out of scope; independent PICO suggestions require a defined pooled screening policy.                                                                                                                         |
| FOLLOW-UP               | Sustained/remote production contention and larger corpora.                                                                                                             | Local burst evidence below; monitor after deployment before further tuning.                                                                                                                                   |

A separate signup-to-export browser run returned to sign-in once after registration.
The unchanged rerun passed before and through screening/export. Tracking that transient
is a follow-up; it did not reproduce in the pooled/PICO 1 or quota workflows.

No remaining known blocker or reasonably scoped should-fix finding was found in the
reviewed paths. The merge recommendation rests on quota, capacity, history, blinding,
atomicity, and coordination evidence below, not test counts alone. PR #11 remains unmerged.

## Safety verification

- **Cross-PICO quota and history:** A2/A3/A5 produces three linked decisions but one logical
  quota credit. A subsequent revision updates all three notes/reasons, keeps the same slot,
  and produces per-copy update audits with previous values. Omitted notes remain saved.
- **Skipping:** opening A, selecting C, changing pages, arrows, and searching create no
  assignments, decisions, or audit events. A remains available to the same reviewer and
  another eligible reviewer. Pending legacy assignments are not reservations.
- **Capacity and races:** at dual capacity, a third reviewer gets `INVALID_STATE`; the loser
  leaves no assignment, decision, success audit, or quota credit. Two different choices
  from one reviewer with one remaining quota unit produce only one new logical review.
  Repeated submissions for the same already-reviewed item are revisions, not extra slots.
- **Quota boundaries:** explicit 199/200 allows one; 200/200 disallows new work; 201/200
  reports zero remaining; increasing 200 to 250 at 200 completed yields 50 remaining;
  lowering to 150 with 175 completed preserves 175; zero pauses new work without hiding
  history. An empty corpus leaves a positive target unmet. Existing smaller-corpus tests
  also exhaust eligibility without exhausting the target.
- **Legacy rows:** quota plus partial PENDING coverage reuses existing row IDs and creates
  only missing rows on decision. Another reviewer's PENDING row does not hide the item.
  Genuine completed fixed work counts once; without a quota, live fixed assignments across
  all copies remain required. A VOIDED marker blocks that reviewer and is never revived.
- **Synchronization:** missing decisions behind COMPLETED markers; decisions without
  COMPLETED assignments (including VOIDED); differing reviewer sets, values, notes,
  exclusion labels, final outcomes, or OPEN-conflict presence all fail closed. A final
  result on only one copy is exceptional. Unequal PENDING coverage alone is allowed.
  Admin All shows exceptions; Available and submission reject them without repair writes.
  Exceptions are excluded from finalized/fully-reviewed health counts. Actual historical
  reviews retain quota credit once, even if a later import makes their group inconsistent;
  this is historical reviewer credit, not a claim that the group is fully synchronized.
- **Maybe/exclusions:** ordinary evaluation is reused. Unanimous Maybe creates conflicts
  regardless of the flag; mixed Maybe follows `maybeGeneratesConflict`; two filled slots
  remain closed even without a final result. Exclusion labels must be active and compatible
  throughout the pool, and notes/reasons propagate per copy. Mismatches roll back all work.
  Browser checks exercise pooled quick exclusion and ordinary quick/dialog exclusion.
- **Finality:** My reviewed shows saved notes and decisions. Revisions are allowed only
  while the linked state is consistent and unfinalized. Final results remove decision
  controls and backend revision attempts fail.
- **Audit/atomicity:** decision-created/updated audits carry the session reviewer,
  guideline/pool IDs, project IDs, and all linked citation IDs. Updates preserve previous
  values. Result/conflict events remain linked by project, stage, and citation. Injected
  later decision-audit, revision-audit, and result-audit failures roll back earlier
  assignments, decisions, changed notes/reasons, final results, and success audits.
- **Blinding/admin:** Available, My reviewed, and Owner/Admin All return only the requester's
  vote/note and aggregate counts, never another reviewer's vote, identity, or unresolved
  conflict details. Final-outcome visibility follows existing rules. Two different admins,
  including an owner without any quota, see identical health counts; personal availability
  remains separate. Dedicated ordinary blinding tests cover other screening endpoints.
- **PICO 1:** the expanded browser workflow covers a 65-article independent corpus,
  arbitrary selection, arrows, pagination, title search, Include, Maybe, notes and revision,
  quick exclusion, exclusion reason plus note, I/M/N/1 shortcuts, four-unit quota, dual-review
  progress, and searched Admin view. Its quota remains separate from the pooled quota.
- **API compatibility:** repository search found the pooled GET route and typed pooled
  workspace as the production response path; assignments and quota routes have separate
  contracts. No script or hidden bundled consumer uses old pooled summary fields. The
  workspace selects by stable group ID. Its response types match the current runtime
  fields and the browser exercises the actual HTTP routes. External consumers, if any,
  must migrate the old GET summary fields with the application; this PR intentionally
  changes that response and does not provide a compatibility alias.

## Locking and query scope

Lock acquisition is transactional and follows this order (IDs sorted within each class):

| Order | Table / scope                                                               | Mode                  | Purpose                                                                                                  |
| ----- | --------------------------------------------------------------------------- | --------------------- | -------------------------------------------------------------------------------------------------------- |
| 1     | Project: every selected pool PICO                                           | FOR SHARE             | Stable grouping corpus; excludes deduplication, import commit/rollback, and destructive project changes. |
| 2     | ScreeningStage: every selected title/abstract stage                         | FOR SHARE             | Stable pool configuration; coordinates quota/configuration writes, adjudication and reopening.           |
| 3     | ScreeningQuota: current pool/current reviewer, if present                   | FOR UPDATE            | Prevents concurrent tabs spending the same remaining quota unit.                                         |
| 4     | Citation: every submitted linked record within selected projects            | FOR UPDATE            | Serializes the logical abstract's capacity and revisions. Exact current group membership is revalidated. |
| 5     | Assignment, decision, result/conflict and audit rows for the selected group | Normal mutation locks | Atomic per-copy materialization and audit.                                                               |

There is no exclusive whole-pool decision lock. Different reviewers on different abstracts
can commit concurrently; a controlled test holds one review midway and proves the other
commits before release. Same-reviewer or same-abstract submissions serialize. Shared stage
guards are never upgraded by the inner writer. Pool/stage/quota management still takes
exclusive stage locks; queued administration and corpus mutations can temporarily block
otherwise independent reviews. This is intentional protection, not unlimited concurrency.

After locking, current pool membership, stage compatibility, exact identity group, linked
state, permissions, quota, finality and capacity are checked again. New matching imports
cannot enter midway. If they commit afterward, the next read classifies the new copy as
needing synchronization. Navigator reads use repeatable read to avoid torn linked state.

Queries use bulk identity/state reads, not per-abstract database calls. A navigator fetch
loads narrow identity and screening state for the selected pool, and hydrates full citation
text only for the page's linked copies (50 logical groups by default; limit capped at 100).
Search scans title/abstract/author/DOI/PMID in SQL and returns matching IDs. Writes load the
selected group's detailed state; quota and transitive grouping still scan narrow identities
across the active corpus. Memory/CPU therefore grow with corpus and history size; the page
limit does not bound this internal work. No speculative indexes or schema changes were made.

## Local contention evidence

The fixture contains 4,110 logical abstracts, 9,203 linked records across PICO 2–6, 40
reviewers, dual screening, and 5,600 seeded historical logical reviews (140 per reviewer,
with target 200). Historical rows are fixture data, not simulated service traffic. The
measured bursts submit actual service transactions: 40 distinct reviewers/abstracts, then
39 contenders for one remaining review slot. PostgreSQL lock waits/transaction age are
sampled about every 25 ms; transaction age includes waiting. Latency includes authorization
and all service work. Baseline used the original locks and returned P2028 expirations.

| Burst                             | Success | Stale rejection | Transaction errors | Median / p95 / max latency |
| --------------------------------- | ------: | --------------: | -----------------: | -------------------------- |
| Original: 40 different abstracts  |      29 |               0 |           11 P2028 | 3,702 / 5,450 / 5,612 ms   |
| Original: 39 contenders, one slot |       1 |              31 |            7 P2028 | 3,307 / 5,221 / 5,387 ms   |
| Hardened: 40 different abstracts  |      40 |               0 |                  0 | 735 / 824 / 824 ms         |
| Hardened: 39 contenders, one slot |       1 |              38 |                  0 | 812 / 1,503 / 1,538 ms     |

The final run observed **zero database deadlocks**. Different-abstract work had **zero
sampled lock waiters** and maximum sampled transaction age 687 ms. Overlapping work had
up to 36 waiters and maximum transaction age 1,401 ms, as expected for the shared citation
locks. Baseline maximum sampled transaction age was 5,003 ms. The earlier narrowed-lock
run also had 40/40 success and 1/38 success/stale with zero transaction errors (different
abstract p95 976 ms; overlapping p95 1,652 ms). Timing varies across local runs.

| Navigator operation        | Final local latency | Returned groups / total matching | JSON bytes |
| -------------------------- | ------------------: | -------------------------------- | ---------: |
| First Available page       |              138 ms | 50 / 2,070                       |    116,054 |
| Title search               |              263 ms | 1 / 1                            |      3,347 |
| DOI search                 |              256 ms | 1 / 1                            |      3,347 |
| PMID search                |              256 ms | 1 / 1                            |      3,347 |
| My reviewed                |              129 ms | 50 / 140                         |    128,346 |
| Next Available page        |              133 ms | 50 / 2,070                       |    116,054 |
| Owner All + health summary |              137 ms | 50 / 4,110                       |    125,910 |

Search timings use one matching title/identifier. First-page eligibility includes the
reviewer's previously unreviewed partially reviewed groups, not just untouched groups.

The contention assertions verify exact surviving decisions/assignments, every reviewer's
quota delta, and 84 successful per-copy decision audits; losing contenders leave none.
The sampled database deadlock counter is also checked. These are local observations, not
a production throughput guarantee or a hard latency SLA.

Not measured: sustained arrival rates, remote database/network latency, multiple deployed
application instances, production connection limits, long-running concurrent imports,
large maintenance workloads, or corpora materially larger than this fixture. Watch p95
submission/queue latency, P2028/lock/connection timeouts, deadlock reports, accumulating
lock waiters, and prolonged synchronization exceptions. Stale-slot rejections are normal
when reviewers choose the same abstract; transaction failures on unrelated work are not.

## Current synchronization repair procedure

1. An Owner/Admin opens guideline Screening, expands Pool health, and selects All abstracts
   in the navigator to locate the exception. Record the linked PICO/citation IDs from the pooled
   response and the affected title/DOI. Review the per-PICO audit logs and conflict records
   through the existing authorized views; the pooled navigator intentionally stays blind.
2. Determine whether the discrepancy is only a partially adjudicated/reopened result or
   genuinely divergent/missing reviewer history. Keep the item unavailable while doing so.
3. For a result-only discrepancy, use the existing per-PICO conflict adjudication/reopen
   workflow consistently across all affected copies, with the real rationale. Resolved
   conflict rows expose Reopen. Consensus results without a conflict have a reopen service
   and authorized API (`POST /api/projects/:projectId/citations/:citationId/reopen`,
   `stageType: TITLE_ABSTRACT`, required `reason`), but no general pooled repair button.
   Reopening retains decisions; a subsequent valid revision reevaluates the linked group.
4. Missing/orphan/VOIDED decisions, imported copies without historical votes, and conflicting
   reviewer histories have no general repair UI in this PR. The Owner/Admin must involve a
   maintainer for a scoped, audited reconciliation after reviewing the original evidence.
   Do not fabricate reviewer decisions, impersonate reviewers, or delete history merely to
   clear the badge. No broad repair script or automatic historical replay is provided.
5. Refresh the pooled queue and verify the exception clears only when linked state actually
   agrees. Check history and quota totals. A removed result alone does not fix unequal votes,
   notes/reasons, or open-conflict state. Repeat per-copy administrative changes can leave
   the item temporarily exceptional until all copies are reconciled.

## AI and migration status

Pooled AI is not implemented. PICO-specific suggestions answer different eligibility
questions and can have different criteria, training context, and calibration. Averaging
scores does not define whether pooled inclusion means eligible for any PICO, every PICO,
or another policy, and can hide meaningful disagreement. This requires an explicit product
and review-method policy; it has no role in the human quota/capacity transaction.

No Prisma schema change, migration, backfill, assignment deletion, or history rewrite is
introduced by this hardening pass. Existing quota/assignment data is reused. Orphan
COMPLETED markers stop receiving unjustified credit; genuine historical work remains.

## Checks run

- `npm run test:unit`: **642 passed / 62 files**.
- `npm run test:integration`: **384 passed / 37 files**, including the new readiness
  cases and realistic contention, pooled/open queues, quotas, ordinary screening,
  blinding, imports and deduplication. The test database migrations were applied by
  the existing test harness; this pass adds no migration.
- `npx playwright test --config playwright.quota.config.ts`: the expanded pooled/PICO 1
  workflow and quota-administration workflow passed. The independent signup-to-export
  workflow initially timed out after signup returned to sign-in, before organization
  creation or screening. Its unchanged targeted rerun passed (18.2 seconds). Thus all
  three workflows have passing executions, but the combined run was not clean. Earlier
  new-test selector/search assumptions were corrected without product UI changes.
- `npm run typecheck`: passed. `npm run build`: passed; its lint step is explicitly skipped.
- Prettier 3.6.2: screening source, new fixture/integration tests, expanded E2E and the two
  reports pass. The three added import-lock lines exactly match Prettier output; whole-file
  formatting of `imports/index.ts` still reports pre-existing issues (also verified at
  the base commit). Unrelated formatting was retained to keep this hardening diff focused.
- `git diff --check`: passed. No lint script or ESLint configuration exists, so no lint
  pass is claimed. There is no GitHub Actions workflow in this checkout.

**Recommendation:** ready to merge for the stated current scale, with no known remaining
screening-data blocker. Quota evidence is tied to real decisions; linked writes/results
and audit rollback together; quota and review capacity serialize correctly; inconsistent
history fails closed; and unrelated reviewer writes run concurrently. Monitor production
latency and the separately observed signup redirect transient. Remote/sustained traffic
and maintainer-assisted reconciliation remain limitations. Do not merge automatically.
