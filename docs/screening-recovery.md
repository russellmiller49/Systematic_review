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
- Groups with final results, retained finalized-result audits, resolved or
  adjudicated conflicts, downstream work, or inconsistent linked state are
  held. This workflow never reopens outcomes, deletes history, or adjudicates.
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
