# Pooled title/abstract adjudication

The guideline's configured abstract pool now has one adjudication workspace at
`/projects/{guidelineId}/screening/pooled/conflicts?poolId={poolId}`. Links appear
in guideline screening and in pooled PICO conflict pages. Full-text conflicts
remain per PICO.

## Invariants

- A single decision resolves every active citation copy in the exact pooled identity
  group in one transaction. Existing per-PICO conflict, adjudication, and stage-result
  rows remain authoritative for downstream eligibility, reporting, and exports.
- Reviewer votes, assignment history, and quota credit are unchanged. Adjudicator
  identity comes from the session. Each audit event carries the same pooled operation
  ID and affected guideline, pool, projects, and citations.
- Only synchronized, currently supported open conflicts can be adjudicated. The live
  vote count and disagreement predicate are checked, including withdrawn-vote rules.
- Every member PICO and the guideline require adjudication permission. Membership
  locks keep authorization stable through commit. Project guards and sorted stage
  locks serialize against screening, imports/deduplication, pool configuration, and
  full-text assignment creation. A state token rejects stale group membership, votes,
  outcomes, assignments, conflicts, citation evidence, or protocol/eligibility context.
  Abstract and protocol writers take conflicting project guards so edits cannot race
  between final context validation and commit.
- Exclusion requires an active matching reason label throughout the configured pool;
  each copy stores its own project's reason ID.
- Multiple copies within one PICO or conflicting DOI/PMID values block pooled writes.
  Divergent history is shown read-only with original per-PICO adjudication attribution
  and rationale. Effective adjudication times come from the current resolved conflict
  or a matching adjudication audit event, never the reused row’s original creation
  time or a later consensus timestamp. Unavailable historical times are labeled unknown.
  There is no automatic historical migration or reconciliation.
- Synchronized adjudicated and consensus outcomes can be reopened together. Reopen
  deletes stage results and voids resolved conflicts, retaining adjudication history.
  A later reviewer revision re-evaluates the conflict under the existing lifecycle.
  Existing full-text assignments, active decisions, or results block reopening.
- Individual PICO title/abstract adjudication and reopen reject pooled members.
  Standalone projects and full-text adjudication retain their original workflows.

## API

- `GET /api/projects/{guidelineId}/screening/pooled/conflicts?poolId=...`
- `POST /api/projects/{guidelineId}/screening/pooled/conflicts`
- `POST /api/projects/{guidelineId}/screening/pooled/conflicts/reopen`

Mutations take `poolId`, the complete `citationIds`, a returned `stateToken`, and a
required rationale. Adjudication additionally takes `finalDecision` and, for an
exclusion, `exclusionReasonLabel`.

The UI preserves a draft rationale after stale responses, requires explicit review
of refreshed records, and blocks the old action when status or target scope changes.
A synchronous submission guard prevents duplicate clicks; server state tokens also
reject concurrent duplicate writes.

## Verification

Dedicated integration coverage includes atomic rollback, permission failures, stale
state, identity ambiguity, withdrawn votes, history preservation, consensus reopening,
full-text assignment races, concurrent adjudicators, and standalone/full-text
regressions. The standalone browser harness uses only in-memory API fixtures:

`node scripts/test-pooled-adjudication-ui.mjs`

The 4,110-abstract scale fixture with 2,001 listed groups produced approximately
5.46 MB of JSON, a 2.82-second list, and a 3.02-second adjudication on the development
Mac. These are diagnostics, not timing gates. The first implementation scans current
pooled state on writes and loads all resolved history; server pagination and narrower
state loading are future improvements. Administrative writes hold stage guards during
that scan, briefly pausing competing screening mutations.

Historical migration remains a separate reviewed operation. This feature does not
move, reinterpret, or overwrite existing inconsistent adjudications.
