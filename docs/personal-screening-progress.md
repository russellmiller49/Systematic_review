# Personal screening progress

The My screening view uses one shared progress card for individual projects and
combined pools. A finite assigned quota displays completed reviews, its target,
and the authoritative remaining count prominently. Article availability is a
separate queue measure, not the reviewer's workload or proof of completion.

The card consumes the existing authenticated `quota` projection. It does not
derive completed credit from linked citation rows, session tally, filtered
article lists, or shared corpus size. Pooled credit continues to count a logical
abstract once. Counting and recovery behavior are unchanged. Positive targets now support explicit
[optional continuation](screening-beyond-quota.md); queue availability is independent
of reaching a positive target.

- A missing quota reports no personal target and unspecified totals. Existing
  fixed assignments and reviewed articles remain usable in the queue; their
  list is not turned into an inferred numerical quota.
- An unlimited quota shows its completed count without inventing a remaining
  target. A zero target reports paused new reviews and retains past completion.
- If a target is reduced below completed work, the actual completed count stays
  visible and the server's remaining count remains zero. Only the visual meter
  is capped at the assigned target.
- Initial loading and failed refreshes show no guessed counts. Background saves
  and refreshes label cached values as last confirmed until a response arrives.
- Existing post-save and 15-second visible polling updates are retained; window
  focus also refreshes progress. External audited withdrawals are visible on
  the next refresh, and re-review uses the same authoritative logical credit.
- Stage/scope keys remain in place; the page additionally keys the workspace by
  its authenticated actor so account navigation does not carry cached progress.
- Admin inspection has no personal card; server permissions and blinded
  projections remain authoritative.

`npx playwright test --config playwright.progress.config.ts` requires an isolated
`TEST_DATABASE_URL` and uses synthetic fixtures. It covers targets distinct from
available records, six-copy pooled credit, withdrawal and re-review, scope/account
switches, zero/exceeded/unlimited/missing targets, loading/error/retry, accessible
counts and meter labels, and desktop/mobile overflow. Existing quota, pooled
navigator and assignment-clarity journeys run in the same feature configuration.

Screenshot artifacts are written to `test-results/personal-progress-desktop.png`
and `test-results/personal-progress-mobile.png`; they contain synthetic data.
