# Optional screening beyond quota

Positive reviewer targets are progress goals. Reaching the goal preserves the
completed/target/remaining display and offers **Continue screening** when eligible
articles exist. The choice applies to the current workspace session and resets on
reload or scope/account remount. Reviewers can stop simply by leaving the workspace.
The meter caps at 100%, completed reviews can exceed the target, and remaining-to-target
stays zero. No eligible articles is a separate state, including when filters hide work.

The queue returns eligible articles after a positive target is reached. New decisions
past that goal require `continueBeyondQuota: true` in the individual, pooled, or batch
request. This is an opt-in, never a permission grant: membership, quota/fixed-assignment
access, voided assignments, ACTIVE citations, pool synchronization, two independent
reviews and final-outcome locks still apply. A target of zero retains its existing pause.
Revisions retain their existing rules and do not earn extra credit. Opted-in writes add
`continueBeyondQuota: true` to the existing decision audit metadata.

Batches remain atomic. A batch that would cross the target without opt-in is rejected
as a whole; reviewers can finish the remaining goal individually, then continue and batch
screen. Extra reviews neither raise the target nor alter pool configuration. Missing
abstract repair follows the same positive-target availability as the queue.

Combined screening still counts one logical abstract across its linked PICO records.
The saved pool is authoritative; no per-PICO multiplication or expansion occurs. Individual
PICOs outside that pool (including PICO 1 in the reported workflow) remain separate.

## Verification and reported 200-abstract stop

Base main and Railway production were verified as
`9224e73c7d456b756e854464aee49e58e2f0e44c`; successful deployment
`77e438e4-f383-4e97-b45a-66dad1832ccb` on 2026-10-13.
Before the fix, three revised/new service tests failed: individual and pooled available
queues became empty at the target, and an opted-in extra decision was rejected.
The new browser journey also failed because it displayed zero available with two
eligible abstracts still present.

There is no hard-coded 200-decision ceiling in queue/write logic. The quota dialog's new
assignment defaults are 200; saved targets drive the stop. This change addresses a
positive-target stop with eligible work. Fahim's actual saved target, assignments and
eligible queue have not been queried from production. If the intended goal is 400 across
PICOs 2–6 but the saved target is 200, correcting that assignment remains separate work.
No personal targets, decisions, invitations or production records were changed here.

Tests cover optional continuation and retained counters, individual and pooled queues,
zero availability, zero-target pauses, missing assignments, removed membership, revision
and duplicate counting, concurrent article capacity, atomic batches, audit continuity,
pooled blinding, scope separation and recovery. Browser coverage uses synthetic data in
a dedicated local test database and exercises the explicit button, keyboard pause,
reload reset, over-target counts and exhaustion in both individual and combined queues.

Final validation: 669 unit tests, 464 integration tests, and 9 browser journeys passed.
`npm run typecheck`, `npm run build`, scoped Prettier checks and `git diff --check` passed.
There is no standalone lint script; the existing Next configuration skips lint during build.
The 40-reviewer pooled contention regression retained exact capacity with zero deadlocks.
