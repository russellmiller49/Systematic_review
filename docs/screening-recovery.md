# Audited pooled screening recovery

When a reviewer used the wrong screening scope, an administrator may need to
withdraw that reviewer's current title/abstract **Exclude** votes so they can
screen the same abstracts again. Maybe remains a real screening decision and
must not be used as an undo substitute.

From the guideline's **Settings → Combined abstract screening → Preview an
audited withdrawal**, select the reviewer and enter a reason. The saved pool
defines the PICO scope; an individual PICO queue is outside this operation.
Preflight is read-only. It reports logical groups, linked copies, eligible and
held groups, and current quota credit. It does not expose another reviewer's
votes or notes.

Only eligible groups can be applied. Original decision IDs, values, attribution,
notes, reasons and labels remain in their rows; inactivity markers exclude them
from current screening views, evaluation, exports and counts. A recovery batch
retains the original selected-reviewer snapshot. Only that reviewer's completed
assignments become pending. Open conflicts are voided with an audit event.
Co-reviewer decisions and assignments remain intact. Logical credit decreases
once per abstract, including multiple copies in one PICO.

## Safety and restoration

- Current owner/admin access to the guideline and every pooled PICO is required,
  along with the selected reviewer's current screening access throughout the
  family and active organization membership.
- Standard recovery holds groups with final results, retained finalized-result audits, resolved or
  adjudicated conflicts, downstream work, or inconsistent linked state are
  held. Standard recovery never reopens outcomes, deletes history, or adjudicates.
- A ten-minute signed preflight is bound to its actor, guideline, pool, reviewer,
  reason and state fingerprint. Execution locks the corpus, stages, quota,
  participants' memberships and selected citations, then rechecks permissions
  and state. A changed plan fails without writes. Retrying the same successful
  token returns the recorded result without a second recovery.
- Recent batches offer **Preview restoration**. Restoration is atomic for the
  entire batch and requires the original pool/group membership, unchanged
  inactive votes and pending assignment IDs, free review capacity and sufficient
  current quota. It reactivates those votes and reevaluates ordinary conflict or
  consensus state; it never overwrites another reviewer's work.
- Retained assignment ID, reviewer, citation, stage and pending status must all
  match. Missing assignments and replacement rows at the former keys are held,
  never substituted. Execution locks retained rows and conditionally updates
  their exact identity/status; a changed association rolls the whole transaction
  back.
- After the reviewer submits a fresh review, the existing unique decision key is
  reused and inactivity is cleared. Original values remain in the recovery
  manifest and append-only audits. Restoring that old batch is then blocked.
- Existing protocol, exclusion-reason, dedup and normal import-deletion history
  safeguards still recognize inactive decisions. An independently authorized
  destructive import-history rollback can remove current rows; the recovery
  snapshot remains, and restoration rejects missing/changed records.
- The bounded operation permits at most 200 logical groups and 2,000 selected
  decision rows. Larger recoveries require a separately reviewed design.

## Schema and release gate

This repair requires migration
`20261013000000_screening_withdrawal`, which adds nullable inactivity markers
and the recovery-batch ledger. Historical identity fields in the ledger are
scalars deliberately: changing or deleting the live pool must not cascade-delete
the recovery evidence. The manifest records exact citation, stage, reviewer,
decision and assignment keys; restoration validates all of them.

## Explicit automatic-consensus recovery

The separate **Automatic two-review exclusion consensus only** mode withdraws
only the selected reviewer's current title/abstract Exclude votes. It necessarily
reopens dependent automatic exclusions: the remaining reviewer is preserved,
but one review no longer satisfies a two-review stage. Include/Maybe choices and
individual PICO queues remain outside this operation.

Before either consensus withdrawal or restoration, an owner/admin must explicitly
confirm that the review lead has cleared external exports, analyses and manuscript
uses that depend on these exclusions, and provide clearance details. No clearance
is inferred from approval to withdraw votes or from zero app-stored dependencies.
The unchecked UI confirmation, details, mode and reason are bound to the signed
preflight and recorded in the private recovery ledger/audit. A changed confirmation
or selection clears the displayed plan. Unknown external use blocks this mode.

Eligibility requires every linked copy to have exactly two completed agreeing
Exclude reviews, an Exclude result with consensus origin, exactly one matching
result-creation audit from a participating reviewer with consistent timestamp ordering, no prior finalization/reopening
history, no conflict/adjudication records, and no current stored downstream work.
Missing, additional or mismatched history remains held. This does not relax the
general historical holds. Every participating pooled stage must require two reviews.

Execution rechecks the signed snapshot under the existing locks. It conditionally
removes only the exact materialized consensus result identities/timestamps, writes
reopening audits, softly withdraws only the target's votes, changes only their exact
completed assignments to pending, and reevaluates derived state in one transaction.
The version-2 JSON manifest retains original result IDs, fields, timestamps and
creation audit fingerprints, the selected reviewer's original vote/assignment
snapshots, and opaque hashes of the remaining work and stage policy. Other reviewers'
vote values or notes do not enter preview responses, signed plans or recovery manifests.
Logical quota credit decreases once per abstract, not once per linked copy.

Whole-batch restoration requires fresh external-use clearance, unchanged original
pool/group/assignment identities, unchanged remaining reviewer work and stage policy,
one remaining Exclude review, no replacement reviews/results/conflicts/downstream
work, available quota, and exactly the original creation audit plus this batch's
matching reopening audit for each result. Extra history blocks restoration. Ordinary
evaluation creates newly audited consensus results; original result identities stay
in the immutable manifest and audits. Any failure rolls back the entire operation.
Existing version-1 batches retain their standard recovery/restoration behavior.

No new database migration is required for this extension. A draft implementation
does not authorize deployment or live recovery: both require independent review,
explicit release approval and resolved external-use clearance. Use synthetic test
fixtures; never put live research identities or decisions in a public PR.

Local tests apply this migration only to disposable synthetic databases.
Production requires a separately approved coordinated migration and application
release, followed by a fresh preflight in the deployed version. Older application
versions ignore inactivity markers. Drain or exclude every older application
instance before enabling live recovery; none may remain during recovery.
Schema-first compatibility lasts only until the first withdrawal marker is set.
Rolling back application code after recovery or subsequent re-review requires
its own reviewed reconciliation of votes, assignments, results, conflicts and
downstream work.

Before any live recovery, verify the exact guideline/pool/reviewer, read the fresh
eligible and held counts, resolve held records separately, and retain the returned
audit reference. No protocol population, eligibility threshold, review target,
account, invitation, or permission is changed by this feature.
