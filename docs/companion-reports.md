# Companion reports across the review lifecycle

A citation duplicate is another imported copy of one publication: choose a canonical and merge.
Companion reports are different publications of one underlying study or cohort: keep the reports
and count the underlying study once. Unrelated records stay separate without a study relationship.

## During deduplication

Choose **Same study / separate report** for conference abstracts, interim/final reports,
follow-ups, or conference/journal publications you judge to share a cohort. Distinct DOIs do
not prevent a companion decision; erroneous shared DOIs cannot override one. The pair becomes
COMPANION with reviewer, time, original IDs and audit history. Both citations remain ACTIVE.
No Study exists merely because this early judgment was recorded.

If every member of a cluster is a separate report of one study, the group action lets you confirm
all current suggestions at once. Its confirmation lists the consequences and pair count. In a
mixed cluster, first classify separate reports pair by pair, then merge only the true copies.

Two copies of the same publication can still merge when both belong to the same companion
family through other reports. For example, a PubMed copy and an Embase copy with DOI
`10.1016/j.gie.2017.01.011` can merge after the other reports are classified. Shared family
membership alone is not evidence that these two copies are separate publications.

A merge is blocked when **any two members being merged** have an explicit COMPANION judgment
between their current canonical roots. This includes historical endpoints that now resolve
through one or more `duplicateOfId` replacements. Reopen that companion decision before merging
those reports; changing the canonical selection does not bypass it. A chain A–X–B alone does
not block merging true copies A and B, but including X in that merge does.

Exact-DOI bulk merge uses the same direct-judgment protection. External companion rows retained
in the original group do not disqualify clean duplicate copies. Existing rejected-pair,
metadata-conflict, mixed-evidence and conference/publication review restrictions still apply.
Original companion rows (including pair IDs, group, reviewer and time) stay unchanged, and
canonical-root projection preserves their meaning. No schema migration is required for this
merge-guard correction.

## After full-text screening

Companion Reports shows the original human confirmations, including current study membership.
These judgments are stronger than algorithmic matches: no rediscovery or second classification
is needed, and the cohort detector does not create competing suggestions. The algorithm's normal
population limits and identical-DOI skip do not apply to this saved human evidence.

Full-text INCLUDE uses the confirmed component to create the first study or reuse its existing
study. Only ACTIVE, full-text included reports get links; excluded or unscreened reports remain
historical evidence. A confirmed chain can connect eligible reports through an excluded report
without linking that excluded report. A merged import copy's relationship follows its current
canonical, while audit and candidate records preserve the original IDs.

Concurrent includes serialize through the same project lock and produce one analysis study.
PRISMA counts included reports separately from their shared study. Extraction and analysis keep
using the existing Study model. Primary selection is preserved when adding later reports.

If multiple studies already exist, shared guarded reconciliation moves reports only when the
source has no extraction/RoB/AI/analysis dependencies, synthesis flag, or notes. It audits moved
links and the study merge. A blocked reconciliation rolls back the decision/inclusion transaction
and explains that manual study reconciliation is needed. No work is orphaned.

## Correcting a decision

Deduplication → **Resolved** distinguishes Merged, Not a duplicate, and Same study / separate
report, and shows who decided and when. **Reopen decision** restores an early companion or
rejection to suggested review. If study linkage has already used the relationship, reopening
fails closed and directs you to study reconciliation; it never silently splits a study.
The applied audit marker intentionally remains protective after later manual relinking. There
is no automatic downstream reset or split in this feature.

Decision authorization is `dedup.manage`; immediate changes to existing eligible study membership
also require `project.edit`. Reviewer-triggered full-text inclusion retains its existing authority.
The new decision is not an automatic clinical or bibliographic inference.
