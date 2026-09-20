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
for audit/undo references. REJECTED/MERGED decisions, decision attribution, and timestamps are
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
ACTIVE, single-DOI groups containing solely exact DOI suggestions, no historical rejected pair,
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
retain separate reports using **Not a duplicate**.

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
