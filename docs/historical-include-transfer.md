# Historical pooled INCLUDE transfer runbook

This is a deliberately separate administrative operation, not automatic reconciliation.
The populated allowlist, preflight, and backup contain private review data: keep them
outside the worktree in access-controlled storage. Never commit them or credentials.
No production application is authorized by this code or this runbook.

## Release sequence

1. Independently review/test and release the pooled-adjudication application fix first.
2. Verify the requesting owner/admin's authenticated identity out of band. The CLI actor
   must be that person, never the historical source adjudicator. The service requires
   active OWNER/ADMIN project membership and adjudication permission for the guideline
   and every pool member; the original source adjudicator also needs adjudication
   permission across the family. Memberships are locked/rechecked in the transaction.
3. Create an external version-1 manifest with batchId, guidelineId, poolId,
   sourceAdjudicatorId, sourceProjectId, expectedGroups, expectedTargets, and groups.
   Each group contains sourceAdjudicationId, sourceDigest (canonical SHA-256 of the
   scalar ScreeningAdjudication row), sourceConflictDigest and sourceResultDigest
   (scalar source conflict and materialized result), citationIds and targetCitationIds.
   Strip nested adjudicator/adjudication relations when computing scalar row hashes. The scope must match the separately approved source/target allowlist and counts,
   with one source in each group. EXCLUDE decisions, ambiguous identities,
   singletons, and all other records are outside the approved scope.
4. Independently review the exact IDs and source values and pin the canonical manifest
   SHA-256. The command rejects any altered manifest. Never regenerate a plan to
   dismiss a stale-state refusal without reviewing what changed.
5. Run dry-run with DATABASE_URL provided in the process environment, not command text:

   npx tsx scripts/transfer-historical-includes.ts --manifest /private/manifest.json --actor VERIFIED_OWNER_ID --approved-manifest-sha256 REVIEWED_HASH --plan /private/plan.json

   The default is dry-run. It writes only the requested local plan file, exclusively
   and durably, and returns the plan hash and counts. It obtains the same locks and
   eligibility checks as apply. It never updates production data.

6. Inspect the plan and obtain explicit authorization for this batch before apply.
   Set INCLUDE_TRANSFER_APPROVED_BATCH to the exact approved batchId in the process
   environment, then repeat with --apply and --backup /private/unique-before.json.
   The reviewed manifest, actor and plan arguments are still required. Dry run and
   apply cannot be combined. The backup file must not exist on first application.

## Safety and provenance

Project share guards precede all sorted exclusive screening-stage guards. A fresh full
pool corpus read catches new identity bridges and duplicate copies. Approved citation rows are locked FOR UPDATE to block downstream FK inserts;
existing actor/source membership rows are locked FOR SHARE. Unrelated projects are
not table-locked. Run in a coordinated maintenance window, with a 10-second lock wait limit and a
120-second transaction timeout. Any timeout rolls back the whole transaction.

Per-group digests include the entire pool/corpus/stage/authority context, complete
citation fields/identifiers, protocol/criteria and exclusion-reason configuration, all reviewer decisions (including withdrawn history),
assignments, conflicts, source adjudication and materialized outcomes. Live decisions
use withdrawnAt=null. Identical live reviewer evidence and a still-valid conflict are
required. Targets must still be exactly the approved OPEN conflicts without outcomes
or adjudications. The source must remain a resolved INCLUDE by the named source
adjudicator with unchanged scalar values and an ADJUDICATION INCLUDE result.

Any full-text assignment, decision, conflict, result, PDF link, retrieval attempt,
extraction form or study linkage blocks the operation, including withdrawn/voided
history downstream. This is intentionally stricter than ordinary reopen.

Before the first database write, the CLI creates a 0600 before-image JSON file with
exclusive-create semantics, fsyncs the file and parent directory, and reads it back
and checks canonical SHA-256. Failure aborts before writes. Backups contain only the
selected review records/context digests, manifest, actor and plan, never credentials,
user password hashes or auth tokens. Keep the backup after failed attempts as evidence.

The transaction bulk-inserts target adjudications/results/audit events and updates
conflicts grouped by historical source time. It never changes original source rows,
reviewer votes, withdrawn history, assignments, or quotas. Target adjudicator/rationale
match the source; target decision time is source conflict.resolvedAt. Audit.createdAt
and metadata.migratedAt identify the actual migration time; audit.userId is the actual
owner/admin actor. Provenance includes source adjudication ID, source row creation
and effective times, batch ID, linked citation/PICO IDs, and backup receipt. The standard
screening.conflict.adjudicated event's flat newValue includes adjudicatorId, reason
and effectiveAt so retained-history UI can distinguish historical action from migration.

## Uncertain commits and retries

An exception does not prove rollback: connection loss may occur after commit. Never
blindly rerun with a new batch ID or regenerate the allowlist. The deterministic batch
audit marker and deterministic row IDs make same-manifest/same-plan retry idempotent.
Retry using the SAME arguments and backup path: if the batch committed and the entire
post-state is unchanged, the command returns alreadyApplied without rewriting the
backup or records. If nothing committed but an earlier backup exists, review its hash,
retain it, then use a new backup filename with the SAME manifest/plan. Changed post-state
fails closed and requires human review. Logs deliberately omit database error payloads.

## Guarded compensation

Rollback is separately authorized and explicitly invoked, never automatic after a
failure. Use the same manifest, actor, approval hash and original plan, --rollback,
and --backup pointing at the verified original before-image. The approval environment
variable is required again. The function verifies the original backup hash and batch
marker, exact unchanged post-state, source, identity/corpus/authority and absence of
downstream work. It deletes ONLY generated target result/adjudication IDs, restores
OPEN/null resolution on their existing conflicts, and appends compensation audit
records. Original source, votes and assignments remain untouched. It verifies exact
before-state digests before committing. Audit history is never deleted. Repeat rollback
is idempotent only while the restored state is unchanged. A rolled-back batch cannot
be reapplied: it needs a newly reviewed batch. If any guard fails, leave everything
unchanged and prepare a manual, clinically reviewed compensating plan; do not restore
an entire old database or erase work that occurred after the migration.
