# Build Status (living document — updated after every milestone)

> Purpose: durable progress anchor. If you are resuming work on this repo, read this first,
> then docs/09-design-review-resolutions.md (the implementation contract), then docs/01–08.
> There is a continuation skill: `.agents/skills/continue-build/SKILL.md`.

## Current state (2026-07-16) — roadmap Wave 4 (GRADE + Summary of Findings) — DONE

Wave 4 is built, adversarially reviewed, and fully verified. This completes the four-wave
2026-07-16 roadmap.

### Verification

- `npm run typecheck` and `npm run build` are clean.
- `npm run test:unit` — **558 passed / 48 files**.
- `npm run test:integration` — **255 passed / 22 files**.
- `npm run e2e` — **9 passed**, including the previously unexecuted GRADE/SoF scenario. Its
  fragile guessed `div` locator was replaced with a role- and heading-scoped domain-card
  locator, and the test now asserts the exact formatted rationale and SoF result.
- Demo DB reseeded and both GRADE and Summary of Findings browser-checked through the real UI.
  The seeded draft is Moderate, starts at High (4) with one downgrade, preserves the human
  indirectness edit, flags publication bias for review, hides AI suggestions while disabled,
  renders `3.00 (95% CI 1.85 to 4.87)` in prose, and renders `3.00 [1.85, 4.87]` in SoF.
- Both GRADE migrations are applied to the development database.

### Review hardening

- Human-facing estimates use the same display precision as the rest of the app, while stored
  metrics retain `round4` precision for deterministic staleness checks.
- The assessment-wide, canonical source fingerprint covers final-only pooled inputs, RoB
  judgment and tool identity, relevant protocol/PICO context, and the evidence displayed to
  the AI. JSON object keys are recursively sorted because Postgres `jsonb` does not preserve
  key order. Legacy rows without a fingerprint are stale by construction.
- GRADE mutations, relevant analysis-source mutations, AI publication, SoF, and export use
  coherent repeatable-read snapshots plus a shared outcome lock; serialization conflicts are
  retried. Slow AI responses are revalidated before suggestions can be published.
- Review status and AI suggestions cannot mask or clear source/context staleness. Stale
  suggestions are hidden and rejected server-side; an out-of-date assessment cannot be marked
  reviewed.
- GRADE audit reads require the caller's current project permissions, and exports preserve the
  existing `analysis.view` boundary at creation and download.

### What landed (all per the build contract; 5 parallel agents over disjoint files)

- **Schema** (migrations `grade` + `grade_source_fingerprint`): `GradeAssessment` (one per
  `AnalysisOutcome`, stored `certainty` recomputed in the same tx as every change, canonical
  `sourceFingerprint`), `GradeDomainRating` (`@@unique
  ([assessmentId, domain])`, `origin AUTO|HUMAN|AI_APPLIED`, `requiresReview`, `metrics Json`),
  `AiGradeRun` + `GradeDomainSuggestion` (`@@unique([analysisOutcomeId, domain])`, latest-wins
  full replace, unaudited), enums `GradeDomain`/`GradeJudgment`/`GradeCertainty`/
  `GradeAssessmentStatus`/`GradeStartingLevel`/`GradeRatingOrigin`, `ExportKind.GRADE`.
- **`src/lib/grade/`** — pure, zero-AI Tier-1 rules mirroring the `src/lib/stats` discipline:
  `rules.ts` (all thresholds exported consts: I² 40/75, OIS 400, ratio appreciable 0.75/1.25,
  SMD ±0.5, RoB weight 50/20/50, pub-bias k<10, Egger p<0.10; certainty = start 4|2 − strikes,
  floor 1), `rob-bucket.ts` (**severity-driven** classifier — string matching would invert on
  AMSTAR 2, whose "high" means high *confidence*; per R2 every `judgmentScale` entry carries
  `severity`, 1 = best), `absolute.ts` (SoF per-1000 math), `types.ts`.
- **`src/server/services/grade/`** — `rob-rollup.ts` resolves each study's overall RoB
  server-side (there was no server resolver; it mirrors the client traffic-light precedence in
  `src/components/rob/summary-tab.tsx` `cell(studyId, null)`): adjudicated > unanimous
  COMPLETED consensus > single **withheld while any co-assessment is IN_PROGRESS or an
  assignment is PENDING** > derived-from-domains (worst bucket). The withholding is
  caller-independent by design — stored GRADE metrics must never contain provisional RoB data.
  `index.ts`: source-fingerprint freshness across every rating origin, `getGradeView`,
  `generateDraft` (final-only results; **AUTO-only replace** so HUMAN/AI_APPLIED ratings survive
  regeneration), `updateDomainRating` (server-authoritative suggestion apply;
  REVIEWED→DRAFT flip), `setStartingLevel`, `markReviewed`, and coherent-snapshot `computeSof`.
- **AI Tier 2** — `AiProvider.completeStructured` (text-only structured completion) added to all
  three transports + `FakeAiProvider`; prompt `grade-v2`; `parseGradeResult` (authoritative:
  drops+counts unknown/dupe domains, invalid judgments, and blank rationales);
  `src/server/services/ai-grade/` cloned from ai-rob minus the PDF path. AI writes only
  version-bound suggestion rows a human applies; indirectness remains a human-review judgment
  because the prompt does not contain study-level applicability characteristics.
- **UI** — `grade-panel.tsx` (certainty badge, points arithmetic, five domain cards, edit
  dialog, regenerate confirm, stale alert, AI suggestion cards), `sof-table.tsx` (+ CSV),
  `certainty-badge.tsx`; analysis page gained a pinned "Summary of findings" aside entry and
  Results|GRADE tabs.
- **Export** `GRADE` kind (export.create + the `analysis.view` mirror at create AND download,
  exactly like ANALYSIS), seed GRADE draft + one human edit, `grade.*`/`ai.grade.*` audit
  actions, `deleteOutcome` cascades the grade rows.

### Decisions/deviations worth knowing (from the agents' reports)

- Fingerprint and metrics comparisons use a **recursive key-sorted stringify**, not plain
  `JSON.stringify`: Postgres jsonb does not preserve key order, so a naive compare marked
  unchanged data stale.
- `updateDomainRating` always audits, but gates the certainty write + REVIEWED→DRAFT flip on an
  actual change — resubmitting identical values cannot silently un-review an assessment.
- Final-only source computation is caller-independent for withholding decisions, while reads
  and exports still run under the caller's R1 visibility boundary.
- AI joins per-study evidence by immutable study ID (with a legacy label fallback), and the
  stored RoB metrics retain raw judgment plus tool identity so prompt and assessment freshness
  change when the underlying tool context changes.
- `AnalysisRole.STUDY_DESIGN` remains **unwired** (declared in Wave 2 for this purpose):
  starting level is a manual audited field on the assessment instead. `replaceMappings` still
  rejects non-NUMBER fields, so wiring it later needs that guard relaxed for that role.
- The GRADE service reuses `analysis.view`/`analysis.manage` — no new capabilities. Audit reads
  for GRADE assessments, ratings, and AI runs re-check current project permission, so actor
  self-visibility cannot leak the result after access is removed.

## Review administration and assignment reset (2026-07-16)

- **Owner/Admin controls:** ✅ The project creator remains the initial `OWNER`; the existing
  multi-role member editor now explains how to add one or more `ADMIN` users, add another
  `OWNER`, and safely transfer ownership (the last-owner invariant remains enforced). Owners
  and Admins can open **Manage assignments** from either screening stage to see per-reviewer
  pending/completed/decision counts.
- **Guarded assignment reset:** ✅ Owners/Admins may remove all pending assignments or only one
  reviewer's pending work. A reason is required and `screening.assignments.reset` is written in
  the same transaction. The delete is atomic and limited to `PENDING` assignments with no saved
  decision; completed assignments, decisions, conflicts, and materialized stage results cannot
  be removed through this control.
- **Reviewer boundary:** ✅ A plain `REVIEWER` has assignment-gated screening access, not
  full-text retrieval administration. The full-text queue is limited to that reviewer's assigned
  citations, screening buttons appear only for a pending personal assignment, and PDF/retrieval
  controls remain available only through a role that grants `fulltext.manage`.
- **Pilot cleanup:** ✅ Cleared 1,121 zero-decision title/abstract assignments from the AABIP
  mTEF KQ1 pilot without deleting citations, protocol data, or the import batch. The reset was
  recorded with its operator reason; the batch is now eligible for guarded deletion if desired.
- Verified from an isolated checkout: typecheck, production build, **167 unit + 177 integration**
  tests. Browser-checked the Owner assignment workload dialog, shared-admin/ownership guidance,
  role descriptions, hidden assignment controls for a Reviewer, and hidden PDF/retrieval admin
  actions for a plain Reviewer.

## Current state (2026-07-16) — roadmap Wave 3 (deep anchoring + proportions + cohort detection) — DONE

Wave 3 of the roadmap is built, reviewed, and committed. Three parallel-agent packages over
a shared schema migration (`wave3_text_layer_cohorts`: `FullTextPage` + text-layer state on
`FullTextFile`, `CohortCandidate` + enums, `Citation.affiliations`, `ExportKind.ANALYSIS`).

- **3A Evidence anchoring phase 3** ✅ — server text layer (`src/server/services/
  fulltext-pages/`, pdf.js legacy build via a webpackIgnore'd dynamic import — NOT
  `serverExternalPackages`, which breaks the client viewer's worker-URL asset in the SSR
  compilation; see next.config.ts), anchor v2 (`src/types/source-anchor.ts`, char offsets
  into OUR stored text, v1 parsed as page-only), producers: AI ingest match-on-ingest,
  manual saves with server re-verification (user selections keep their exact offsets when
  they verify — repeated quotes are never snapped to the first occurrence), FormWorkspace
  "Select in PDF" (document-level mouseup, 8k-limit feedback), and the audited re-anchor
  backfill (`extraction/reanchor.ts`, coverage report, preserves current-version selection
  anchors, bounds-checked page-only fallbacks). Browser-verified against the real dev
  server: re-anchor over the seeded demo = 20/20 exact.
- **3B Meta-analysis phase B** ✅ — single-arm PROPORTION (logit w/ 0.5|1 continuity;
  Freeman–Tukey w/ Miller inverse incl. achievable-range clamp, per-study n for study
  display, harmonic-mean n for the pooled display), GENERIC_IV (SE or CI→SE; pools
  as-entered), prediction intervals (t, k−2, k≥3), Egger's test (SND-on-precision OLS,
  k≥3, null when precisions are identical — the UI distinguishes that from k<3), funnel
  plot (layout mirrors forest-plot pattern), `studentt.ts` qt via inverse incomplete beta —
  ALL pinned against the extended independent scipy reference (13 fixtures + qt/Egger pin
  files, TS↔Python agreed first run). "Generate outcome fields" scaffold
  (`analysis/scaffold.ts`, analysis.manage + extraction.templates, DRAFT template, one tx;
  draft-field delete/rename/retype now refuse while mapped). ANALYSIS export (export.create
  AND analysis.view at create + download; content computed as the requester so the R1 blind
  applies; CSV formula-injection neutralized in serializers).
- **3C Cohort detection** ✅ — parsers capture NBIB AD/SI + RIS AD/C1 affiliations and
  registry ids (`registry-ids.ts`: NCT/ISRCTN/ACTRN/ChiCTR/DRKS/EudraCT+EUCTR, optional
  space/hyphen separators, 8-digit NCT strictly); commitBatch persists both; engine
  (`cohort/engine.ts`): tier-1 shared registry id 0.98, tier-2 composite (.40 author/.20
  affiliation/.25 title/.15 year, renormalized on missing signals, authorOverlap ≥ 0.2
  gate, ≥ 0.55 emit; acronyms pass a document-frequency rarity filter + roman-numeral/RCT
  stoplist); service: idempotent runs (decided pairs never resurrected; stale-SUGGESTED
  deletion status-guarded against concurrent decisions and skipped entirely when the
  2000-citation population cap was hit; 60s tx timeout), lazy raw-record backfill, link
  cases 1/2/3 with the merge guard covering EVERY restricting Study relation (incl. AI
  runs/suggestions + analysis exclusions → 422, never P2003), reject; "Companions" tab;
  seeded NCT-sharing Criner companion pair + e2e.
- **Review pass**: 8-dimension adversarial workflow over the whole Wave 3 diff (54 agents,
  every finding double-verified): 23 confirmed findings — 0 critical/high, 6 medium, 17
  low — ALL fixed (list in the commit message; notable: blinding + resolver invariants from
  Wave 2 were checked for regression and held).
- Verified: typecheck, production build, **445 unit / 221 integration / 8 E2E**; browser
  checks on the reseeded demo (re-anchor coverage toast, funnel + Egger k<3 messaging,
  mappings, Companions tab reachable; cohort link flow covered by e2e).

## Wave 2 review + hardening (2026-07-16, follow-up session)

The three pending items below were completed:

1. **Clean verify pass** ✅ — with the dev server stopped: typecheck, production build,
   343 unit, 185 integration, 7 E2E, all green (before the review fixes; re-verified after).
2. **Review pass** ✅ — an 8-dimension multi-agent review over the Wave 2 diff (stats
   numerics, resolver precedence, route security/tenancy/blinding, service logic,
   analysis UI/forest plot, PDF viewer, quote matcher, schema/seed/tests), every finding
   independently verified by two adversarial agents. 13 findings confirmed, all fixed:
   - **Resolver version precedence (high)**: `fetchResolvedRoleValues` flat-pooled
     completed values across the whole template lineage — re-extraction on a new version
     produced unresolvable false disputes (no cross-version conflict can exist), one
     extractor on two versions minted a fake CONSENSUS, a stale v1 adjudication could
     nondeterministically shadow a newer v2 consensus, and a stale OPEN v1 conflict
     permanently blocked pooling. Now: per (study, role) the NEWEST lineage version with
     a final signal (completed value or live conflict) wins outright; deterministic
     version-desc ordering.
   - **R1 blind mirror on analysis results (high)**: `computeOutcomeResults` leaked
     co-extractor pre-consensus data (SINGLE values, `?provisional=1` values from
     IN_PROGRESS forms, and dispute existence) to any `analysis.view` holder — a
     STATISTICIAN co-extractor could anchor on their counterpart's numbers. Now the
     listForms seeAll rule (extraction.adjudicate || project.edit) gates it: non-seeAll
     callers get no provisional tier (`provisionalAllowed:false` in the payload, checkbox
     hidden), SINGLE values are withheld while any lineage version has an in-progress
     form or pending assignment for the study, and disputed rows render as generic
     "Extraction not finalized" incomplete rows.
   - **UI race (medium)**: results-table had no staleness guard — a slow response for a
     previous outcome could overwrite the current outcome's numbers. Request-generation
     counter added (repo's cancelled-flag pattern).
   - Also: erfc/pnorm NaN on x² overflow (saturates to 0/2 now); non-finite
     inverse-variance weights excluded in computeMeta instead of poisoning pooled sums;
     qnorm's r>5 deep-tail branch genuinely pinned against scipy (the old "deep tail"
     test actually hit the middle branch); draft templates rejected from mappings (their
     fields are deletable → orphaned fieldKeys); mapping audit payloads record
     (templateId, fieldKey), not fieldKey alone; PDF highlight no longer splits a
     trailing surrogate pair; seed uploads the authored Davey PDF (was dead data); the
     E2E highlight assertion now proves geometric overlap with the quoted text span.
   - Quote matcher reviewed line-by-line (offset map under every length-changing
     normalization): no defects.
   New coverage: +4 stats unit tests, +7 integration tests (version precedence ×3,
   blinding ×2, draft-mapping rejection, audit payload).
3. **Docs** ✅ — backlog #5 (meta-analysis phase A) and #12 (evidence anchoring phase 2)
   marked done in docs/08-milestones.md.

## Prior state (2026-07-16) — roadmap Wave 2 (meta-analysis + PDF evidence viewer) — BUILT

Wave 2 of the roadmap (plan file `~/.claude/plans/i-m-interested-in-utilizing-jiggly-hennessy.md`)
is code-complete. (Wave 1 was committed as 502a5cf during the concurrent session; Wave 2
was working tree until the review above landed.)

### What landed

- **Schema** (migration `analysis_outcomes`): `AnalysisOutcome` (name, timepoint, measure,
  direction, model, groupLabels, optional `outcomeDefinitionId` protocol anchor),
  `AnalysisFieldMap` (unique per `(outcome, role)`; stores `templateId` + stable `fieldKey`),
  `AnalysisStudyExclusion` (manual sensitivity valve). Enums `EffectMeasure`, `PoolingModel`,
  `ProportionTransform`, `EffectDirection`, `AnalysisRole`.
- **Permissions**: new `analysis.view` / `analysis.manage` capabilities in
  `src/server/permissions/matrix.ts` (STATISTICIAN both; ADJUDICATOR/PANEL_MEMBER/OBSERVER
  view; OWNER/ADMIN all; EXTRACTOR/REVIEWER neither). Audit actions `analysis.*` added.
- **Stats library** `src/lib/stats/` — pure, deterministic TypeScript, **no AI in any
  computation**: `normal.ts` (qnorm AS241, pnorm via incomplete gamma), `chisq.ts`
  (regularized incomplete gamma; exports the shared gamma helpers), `effects/binary.ts`
  (log RR / log OR / RD, 0.5 continuity correction when any cell is zero, double-zero and
  double-full excluded from RR/OR), `effects/continuous.ts` (MD; SMD as Hedges g with the J
  correction), `pool.ts` (fixed IV + DerSimonian-Laird, Q/df/p, I², τ²), `meta.ts`
  (`computeMeta`, never throws — bad studies come back in `excluded`).
  Correctness is pinned by golden fixtures generated by an INDEPENDENT Python/scipy
  reference (`scripts/generate-stats-fixtures.py` → `src/lib/stats/__fixtures__/*.json`,
  asserted by `fixtures.test.ts` at 1e-8 / 1e-6 tolerances). That cross-check caught two
  real numerical bugs during the build (a Lanczos t-shift and AS241 coefficient typos), so
  the fixtures are load-bearing — regenerate them if the policies ever change.
- **Analysis service** `src/server/services/analysis/`: `index.ts` (listOutcomes,
  getOutcome, createOutcome, updateOutcome — measure is immutable, deleteOutcome,
  replaceMappings, setStudyExclusion, computeOutcomeResults) + `resolve-values.ts` (pure
  `resolveNumericField` + `expandTemplateLineage` + batched fetch). Value precedence
  ADJUDICATED > CONSENSUS > SINGLE, with `disputed`, and PROVISIONAL only when
  `?provisional=1`. Mappings resolve across a template's version lineage. Five routes under
  `api/projects/[projectId]/analysis/…`.
- **Analysis UI**: sidebar entry + `app/(app)/projects/[projectId]/analysis/page.tsx` and
  `src/components/analysis/` (analysis-page, outcome-dialog, mapping-editor, results-table,
  types). Results poll every 10s while visible + refetch on focus = the "live" plot.
- **Forest plot**: `src/components/analysis/forest-plot-layout.ts` (pure layout → SVG
  string, mirroring the PRISMA `diagram-layout.ts` pattern) + `forest-plot.tsx` (data-URI
  `<img>` + SVG/PNG download, mirroring `prisma-diagram.tsx`).
- **Quote matcher** `src/lib/quote-match.ts`: isomorphic, zero-import normalizer
  (NFKC, smart quotes/dashes, soft hyphens, de-hyphenated line wraps, whitespace collapse)
  with an exact-then-fuzzy search and an exact raw↔normalized offset map. 58 unit tests.
- **PDF evidence viewer** `src/components/pdf/`: `pdf-evidence-viewer.tsx` (public wrapper;
  dynamic import, ssr:false, error boundary falling back to the previous `<iframe>`),
  `pdf-viewer-impl.tsx` (pdf.js canvas + text layer + DOM-Range highlight rects, page
  nav/zoom, match-status chip), `error-boundary.tsx`. Wired into the extraction Table tab's
  evidence dialog and into `form-workspace.tsx` quote blocks. Dependency: `pdfjs-dist@6.1.200`.
- **Seed** (`prisma/seed.ts`): `demoPdf()` now emits REAL text-bearing PDFs (correct xref
  offsets, Helvetica content stream, 2 pages for the two extracted studies); `DEMO_PDF_PAGES`
  holds the page text and `DEMO_QUOTES` attaches `sourceQuote`/`pageNumber` to seeded
  extraction values, so the evidence viewer has genuine anchors to locate. Four binary count
  fields added to the demo template (`resp_valve_events/total`, `resp_control_events/total`)
  plus a seeded `FEV1 responder` RR outcome with its four field mappings.

### Verified so far

- `npm run typecheck` clean; `npm run build` clean; **343 unit tests** pass.
- `tests/integration/analysis.test.ts` (8 tests) passes: consensus + adjudicated pooling,
  disputed/incomplete/excluded/not-pooled classification, provisional mode, template-version
  lineage, MD continuous path, permissions + R9 tenancy, empty analysis.
- `e2e/evidence-and-analysis.spec.ts` (2 tests) passes: the evidence viewer renders the PDF
  and paints a real highlight rect with measurable geometry over the quote; the Analysis page
  renders the forest plot with the correct numbers.
- Browser-checked the Analysis page on the seeded demo: Criner RR 2.91 [1.60, 5.28] (66.1%
  weight), Slebos 3.19 [1.39, 7.35] (33.9%), pooled random effects 3.00 [1.85, 4.87],
  Q=0.03/df=1/p=0.858/I²=0%/τ²=0, Davey correctly "Incomplete" (no extracted counts). Those
  match hand-computed values: (60/128)/(10/62)=2.90625 and (18/47)/(6/50)=3.1914.

### Still pending

All four handoff items (clean verify, review pass, docs, commit) were completed in the
follow-up session — see "Wave 2 review + hardening" above. Verified totals after the
review fixes: 347 unit, 192 integration, 7 E2E.

### Notes worth keeping

- The MCP browser pane reports `document.visibilityState === "hidden"`, and pdf.js drives its
  canvas render loop with `requestAnimationFrame` (`useRequestAnimationFrame: !intentPrint`),
  which never fires in a hidden document. So the PDF viewer can NOT be verified in the pane —
  it stalls at "rendering" there. Use Playwright (`e2e/evidence-and-analysis.spec.ts`), whose
  Chromium actually paints. This is not an app defect; it is standard pdf.js behavior.
- Related: the highlight measurement in `pdf-viewer-impl.tsx` was moved OFF
  `requestAnimationFrame` to a synchronous `getClientRects()` call after render (which forces
  layout anyway). That is a robustness improvement for backgrounded tabs, not a fix for a
  user-visible break.
- Concurrent work from another checkout landed in this repo during the session (screening
  assignment reset, REVIEWER losing `fulltext.manage`, a `screening.assignments.reset` audit
  action, and its own STATUS.md section). Leave it alone; Wave 2 is additive to it.

## Prior state (2026-07-16) — AI-features roadmap Wave 1 (AI RoB + living extraction table)

A five-feature prioritized roadmap was planned (plan file:
`~/.claude/plans/i-m-interested-in-utilizing-jiggly-hennessy.md`): living extraction tables
w/ sentence anchoring, effect sizes + forest plots, PRISMA auto-tracking (found already
complete), AI RoB suggestions + cohort detection, GRADE drafts. Build order: quick wins →
meta-analysis (binary/continuous first, proportions next) → deep anchoring/cohorts → GRADE.
Wave 1 is done:

- **AI RoB suggestions (roadmap #4a)**: ✅ `AiRobRun` + `RobSuggestion`
  (`@@unique([toolId,studyId,domainId])`, latest-wins full replace; migration
  `20260716154758_ai_rob_suggestions`). One sync `extractFromPdf` call per (study, tool)
  covering ALL domains (PDF dominates tokens): `runRobSuggestion` (rob.assess; PUBLISHED
  project-or-builtin tool; reuses `resolveStudyPdf`; reuses `AI_EXTRACTION_MODEL` — add a
  dedicated env if they ever diverge). Prompt `rob-v1` (`src/server/ai/prompts/rob.ts`)
  serializes the full tool structure (domains + SQs + allowedAnswers + judgmentScale +
  guidance) so all six seeded standard tools AND custom tools work; conditional-NA rules
  ride on guidance strings. Wire schema uses a UNION answer enum (not per-question oneOf —
  OpenAI strict-mode safe); authoritative per-question validation on ingest
  (`parseRobResult` clamps: rationale ≤4000, quotes ≤3×1500, answer quotes ≤500). Per
  domain: applyable | invalid judgment (kept + invalidReason, never applyable) | notFound
  (not assessable). Apply is server-authoritative via `rob.applySuggestion` (one atomic tx:
  judgment + support built from rationale + "p. N: “quote”" lines [10k clamp, quotes win] +
  valid signaling responses with "“quote” (p. N)" notes; `assertJudgmentInScale` +
  `assertNotAdjudicated` intact; audit `ROB_JUDGMENT_*` with
  `{appliedFromSuggestionId, aiProvider, aiModel}`). Audit run-level only (`ai.rob.*`).
  R1 note: suggestions shared across dual assessors — same documented tradeoff as
  extraction. UI: assessment-workspace gains "AI draft"/"Apply all (n)" header buttons
  (gated `ai.enabled` + own + IN_PROGRESS + PDF present), per-domain suggestion cards
  (JudgmentBadge + confidence + quotes + Apply/Dismiss), per-question "AI: Y" hint chips.
- **Living extraction table, phase 1 (roadmap #1a)**: ✅ new "Table" tab on the extraction
  page. `getExtractionMatrix` (`src/server/services/extraction/matrix.ts`) + pure
  `resolveMatrixCell` (`matrix-resolve.ts`): precedence ADJUDICATED (RESOLVED conflict's
  finalValue) > disputed (OPEN conflict, or completed disagreement) > AGREED (≥2 COMPLETED
  `valuesEqual`) > SINGLE > empty; VOIDED conflicts ignored. Blinding reuses the `listForms`
  rule verbatim (extraction.adjudicate || project.edit ⇒ see all + conflicts/adjudications;
  else own forms only — a personal table, no dispute leak). Batched study→PDF resolution
  mirrors `resolveStudyPdf` ordering. UI (`matrix-tab.tsx`): sticky first column, source
  badges (Adjudicated/Agreed/Single/Conflict), evidence dot, cell popover (per-extractor
  entries + quotes + adjudication reason + "Open in PDF"), iframe PDF dialog with `#page=N`
  + quote banner (Safari may ignore #page — accepted, fixed by roadmap phase 2 pdfjs
  viewer), client-side CSV export (papaparse), focus + 60s refetch. New routes:
  `GET extraction/matrix?templateId=`, `GET studies/[studyId]/pdf` (project.view — works
  with AI off). New `src/components/ui/popover.tsx` primitive (dep already present).
- **PRISMA (roadmap #3)**: verified already fully automatic (all 11 counts incl.
  `reports_not_retrieved` latest-attempt logic at `prisma-report/index.ts:82-100`);
  nothing built; completeness polish recorded as docs/08 backlog #13.
- Verified: tsc, next build, **167 unit + 174 integration**, 5/5 E2E; browser-checked the
  Table tab on the seeded demo (Agreed badges, Adjudicated badge on Criner 2018 sample size,
  popover showing "Adjudicated: 190 by Ada Adjudicator" + both extractors' 190/180 values)
  and the RoB page (AI controls correctly hidden while `ai.enabled=false`). AI RoB flow
  covered end-to-end by `tests/integration/ai-rob.test.ts` (FakeAiProvider). Demo DB was
  only read during browser checks (no reseed needed).
- Next up (roadmap Wave 2): meta-analysis phase A (AnalysisOutcome + field-role mapping +
  `src/lib/stats/` with metafor golden fixtures + forest-plot SVG per diagram-layout
  pattern; binary + continuous first per user) and pdfjs viewer + quote highlight
  (`src/lib/quote-match.ts`). Then Wave 3 (anchor v2 + proportions + cohort detection
  incl. NBIB/RIS affiliation + registry-ID capture), Wave 4 (GRADE + SoF).

## Pilot deployment (2026-07-14)

- **Live:** `https://synthesis-production-07a3.up.railway.app` in the dedicated Railway
  `synthesis-pilot` project (Pro workspace).
- Architecture: one Railway Node service, managed PostgreSQL, and a persistent `/data` volume
  for full-text PDFs. Migrations + the idempotent built-in RoB bootstrap run before deploy;
  `/api/health` gates traffic.
- Access: `PILOT_EMAIL_ALLOWLIST` restricts initial signup; active project invitations also
  permit the invited email to register. AI is disabled until a provider key is configured.
- Delivery is currently a manual CLI upload (`railway up`); no Git remote is configured.
- Operator follow-up: enable scheduled backups for both Postgres and the web file volume in
  Railway. See `docs/10-pilot-deployment.md`.

## Import rollback (2026-07-15)

- Import batches can now be deleted from the import list or batch-detail view through a
  destructive confirmation dialog. PREVIEWED batches remove only their preserved source rows;
  COMMITTED batches also remove citations created solely by that batch.
- The rollback is deliberately guarded: citations linked to another import are retained, while
  screening decisions/assignments, resolved dedup work, study/full-text links, extraction work,
  AI suggestions, or an active AI screening run block deletion instead of being cascade-deleted.
  Unreviewed dedup suggestions are derived data and are safely regenerated after reimport.
- The endpoint is tenant-scoped, requires `import.manage`, serializes against commit, and records
  `import.batch.deleted` with the prior batch metadata and deletion counts.
- Verified: typecheck, production build, **145 unit + 165 integration** tests; browser-checked the
  list action, committed-import warning, cancel path, and detail-page delete action.

## Current state (2026-07-14) — post-MVP backlog items 3–4 (AI prescreening + AI extraction)

- **Multi-provider AI layer (`src/server/ai/`)**: domain-shaped `AiProvider` interface
  (createScoringBatch/getScoringBatch/cancelScoringBatch/extractFromPdf) with three thin
  transports — `anthropic` (default, Message Batches + base64 PDF document blocks + streamed
  extraction, structured output via `output_config.format json_schema`), `openai` (Batch API
  JSONL + `response_format json_schema strict` + data-URL file parts), `gemini` (Batch Mode
  inlined requests + `responseJsonSchema` + inlineData; positional results mapped via the run's
  `requestKeys`). Prompts (`prompts/screening.ts` v screening-v1, `prompts/extraction.ts` v
  extraction-v1) and result parsing/clamping (`schemas.ts`) are shared pure functions. Config
  via env: `AI_PROVIDER` + per-provider key + `AI_SCREENING_MODEL`/`AI_EXTRACTION_MODEL`
  (anthropic default `claude-opus-4-8`); missing key ⇒ `ai.enabled=false` on the project
  payload ⇒ all AI UI hidden and endpoints 422. Test seam: `setAiProviderForTests()` +
  `tests/fake-ai-provider.ts` (no vi.mock; mirrors the `getStorage()` singleton pattern).
- **AI prescreening (backlog #3)**: ✅ `AiScreeningRun` + `ScreeningSuggestion`
  (`@@unique([stageId,citationId])`, latest-wins; score 0–100 clamped, suggestedDecision,
  rationale, provider/model/promptVersion denormalized per docs/01). Batch lifecycle with NO
  background worker: `startPrescreenRun` (screening.configure; TA stage only; skips settled/
  duplicate/empty-title/already-suggested unless `rescoreExisting`; run row PENDING → provider
  call outside tx → SUBMITTED/FAILED) and `pollPrescreenRun` (idempotent; `FOR UPDATE` +
  status re-check so concurrent polls ingest once; chunked delete+createMany; failedCount =
  totalCount − succeeded). UI: `PrescreenPanel` on the TA tab (run + re-score checkbox +
  10s auto-poll + refresh/cancel + usage tokens) and two audited stage toggles —
  `aiShowScores` (default on; gates `aiSuggestion` in the queue payload) and
  `aiRankingEnabled` (default off; `getQueue` sorts score desc, unscored last, FIFO ties).
  Queue card shows an `AI likelihood: N/100 · suggests X` badge with collapsible rationale.
- **AI extraction (backlog #4)**: ✅ `AiExtractionRun` + `ExtractionSuggestion`
  (`@@unique([templateId,studyId,fieldId])`, full-replace per run). `runExtractionSuggestion`
  (extraction.perform; PUBLISHED template; study→primary-report→`CitationFullTextLink` PDF
  resolution; per-provider `maxPdfBytes` guard) calls the provider synchronously (minutes-long
  request is fine on the Node server — first JobRunner customer if ever serverless), then per
  field: `validateFieldValue` pass ⇒ stored valid; fail ⇒ stored with `invalidReason` (never
  applyable); missing/`found:false` ⇒ `notFound`. Apply is server-authoritative through the
  EXISTING `upsertValue` (`appliedSuggestionId` in `upsertValueSchema`): value/quote/page/
  sourceAnchor copied from the suggestion row (client value ignored), all guards intact, audit
  metadata `{appliedFromSuggestionId, aiProvider, aiModel}` — this activates the previously
  inert `ExtractionValue.sourceAnchor`. UI: `FormWorkspace` gains "AI draft" (disabled w/
  tooltip when no PDF), "Apply all (n)" (fills only EMPTY editable fields), and per-field
  chips (valid ⇒ formatted value + confidence + quote/page + Apply/Dismiss; invalid/notFound
  ⇒ muted notes).
- **Cross-cutting**: audit actions `ai.prescreen.*`/`ai.extraction.*` (run-level only —
  suggestion rows deliberately unaudited); AI run entities NOT in R1 sensitive lists (carry
  no reviewer votes — comment in audit-query); permissions reuse (`screening.configure` /
  `extraction.perform`, no new capabilities); `getProject` payload gains
  `ai: {enabled, provider, screeningModel, extractionModel}`.
- Verified: tsc, next build, **141 unit + 160 integration**, 5/5 E2E; browser-checked both
  flows on the seeded demo (panel states + eligible counts, provider-401 error path marks run
  FAILED with toast, ranking reorder + both badge variants, extraction chips in all three
  states, Apply end-to-end with DB-verified sourceAnchor + audit provenance). Demo DB reseeded
  after verification; `.env` keys left empty (AI disabled until a real key is set).
- New: `E2E_PORT` env for Playwright (default 3000; use when another app occupies the port —
  `reuseExistingServer` would otherwise latch onto the foreign server); `.claude/launch.json`
  gained a `dev-alt` config on port 3457.
- Known follow-ups (AI): no worker — a SUBMITTED batch only progresses while the panel polls
  (provider batches expire ~24h ⇒ expired items map to failed, re-runnable); gemini inline
  batches cap at ~15MB total payload (clear error suggests smaller runs or another provider);
  openai/gemini default model ids (`gpt-5.1`, `gemini-2.5-pro`) are conservative — override
  via env; extraction suggestions are shared across dual extractors (weakens independence —
  deliberate, documented tradeoff); FULL_TEXT-stage prescreening not offered (extraction
  covers full text).

## Prior state (2026-07-12) — post-MVP backlog items 1–2

- **PRISMA 2020 flow diagram (backlog #1)**: ✅ `src/components/prisma/diagram-layout.ts` is a
  pure layout + SVG-string renderer (word wrap, XML-escaped user labels, unit-tested);
  `PrismaDiagram` shows the exact downloadable artifact as an `<img>` data URI with SVG/PNG
  (3× canvas) downloads. On the PRISMA page for live counts AND inside the snapshot detail
  dialog (works from frozen counts). Fixed manuscript palette by design — it is a document
  artifact, not a themed surface. Diagram omits the "other methods" arm (app only tracks
  database imports) and adds a quantitative-synthesis line when the count is present.
- **Built-in RoB tool catalog (backlog #2)**: ✅ `ensureBuiltinTool(def)` mechanism in
  `src/server/services/rob/builtin.ts` (idempotent by tool name); six standard instruments in
  `src/server/services/rob/standard-tools.ts`: RoB 2 (5 domains/22 SQs, NA on conditionals),
  ROBINS-I (7/34), QUADAS-2 (4/11, applicability noted as not modeled), NOS cohort (3/8,
  star-marked answer options), JBI RCT checklist (13 items grouped by JBI bias domains),
  AMSTAR 2 (16 items, confidence scale). Each has its own judgment scale; answers are the
  published formats (Y/PY/PN/N/NI codes, Yes/No/Unclear, star options, Partial yes /
  No meta-analysis). `ensureBuiltinStandardTools()` called from `prisma/seed.ts`.
- Verified: tsc, next build, **111 unit + 146 integration**, 5/5 E2E green; browser-checked the
  diagram (live + snapshot dialog + PNG canvas path) and the RoB Tools tab (7 builtins with
  correct scales/counts, clone flow intact) on the seeded demo.
- New: `.claude/launch.json` (browser-pane dev server config).

## Prior state (2026-07-06)

- **M8 UI wave + seed + E2E + docs**: ✅ All 12 project workspace pages built (9 parallel agents,
  disjoint file groups) as client components over the REST API — dashboard, protocol (6 tabs +
  inline amendment gate), import (upload→preview→commit), dedup (PairCompare + merge/undo),
  screening (keyboard-first queue + optimistic advance + **new assign-reviewers dialog**),
  conflicts (adjudicate/reopen), full text (retrieval + PDF up/serve + FT decisions), extraction
  (template builder + dynamic typed forms + conflicts), RoB (tool builder + assess + traffic-light
  summary), PRISMA (grouped counts + snapshots + exports), audit (filter + DiffViewer), settings.
  `prisma/seed.ts` seeds the full demo THROUGH the services (verified: 17 active citations, 3
  dedup pairs merged, 3 screening conflicts [2 adjudicated/1 open], 3 studies, 1 extraction + 1
  RoB adjudicated conflict, coherent PRISMA flow). Playwright E2E: happy path (sign-up→export),
  adjudication, authz smoke — 4/4 green. README written. tsc + next build + 98 unit + 140
  integration all green. Committed a1a7d23, ea04708.
  - Gap found & fixed during E2E: there was **no screening-assignment UI** (RoB/extraction had
    one, screening didn't), so a fresh project's citations never reached a reviewer's queue via
    the UI. Added `AssignReviewersDialog` gated to `screening.configure`.
- **Final code review**: ✅ Multi-agent review (10 domain reviewers × adversarial verify) over
  all UI + seed against the real API contracts and R1 blinding. Result was clean for 81
  parallel-built files: 1 confirmed low-severity finding (PRISMA export dropdown offered
  project.edit-gated kinds to export.create-only roles → always-403 toast; fixed by filtering
  kinds to the caller's capability) + 1 latent seed fragility (extraction adjudication used a
  hardcoded finalValue; fixed to key the value to the conflict's field). Both fixed; verify loop
  still green (tsc, next build, 98 unit + 140 integration, 5/5 E2E).

**MVP COMPLETE.** The 17-step acceptance walk-through (sign-up → export) is achievable through
the UI and demonstrated by the seed + E2E. Remaining items are all post-MVP backlog (docs/08).

## Prior state (2026-07-05)

- **M1 Plan**: ✅ docs 01–08 + 09. Adversarial multi-agent design review: 32 confirmed findings,
  all resolved in the schema and docs/09 (R1–R18 are binding policies).
- **M2 Scaffold**: ✅ Next.js 15 + TS strict + Tailwind v4 + owned UI kit (src/components/ui),
  Docker Postgres (port 5442; srb_dev + srb_test), Prisma migrated (`init`), Auth.js
  credentials (sign-up/sign-in works), errors/api-utils/permissions/audit backbone,
  Vitest unit + integration infra.
- **M3–M7 services & APIs**: ✅ ALL DOMAIN SERVICES AND ~70 API ROUTES BUILT (9 parallel agents)
  and verified together: `tsc` clean, **96 unit + 140 integration tests green**, `next build`
  green. Committed at `26bf96c`. Domains: orgs, projects/members/invitations,
  protocol/versions/amendments/exclusion-reasons, import (RIS/BibTeX/CSV/NBIB parsers with
  golden fixtures), citations, dedup (Jaro-Winkler engine + merge/reject/undo), screening
  (blinded dual, conflicts, adjudication, CitationStageResult lifecycle, reopen), studies
  (auto-created on FT include), fulltext (FileStorage + PDF magic-byte validation + serving +
  retrieval attempts + queue), extraction (template builder/publish/new-version, typed values,
  dual conflicts, adjudication), RoB (custom tools + builtin generic seedable via
  `ensureBuiltinGenericTool()`, string judgments validated per tool scale, domain+overall
  conflicts), audit query (R1 blind-filtered), PRISMA live counts + snapshots, exports
  (CSV/JSON, R1-gated), project dashboard endpoint.
- **UI**: shell only — app layout + user menu, /orgs list + create, /orgs/[orgId] (projects
  grid, new-project wizard with all spec fields, org members table), project sidebar layout,
  shared CitationCard / PageHeader / StatCard. **The 12 project workspace pages are NOT built.**

## Remaining work

**None for MVP.** The whole 2026-07-16 AI roadmap is built and verified: Wave 1 (AI RoB #10 +
living extraction table #11), Wave 2 (meta-analysis phase A #5 + evidence anchoring phase 2
#12), Wave 3 (anchoring phase 3, meta-analysis phase B, cohort detection #9), and Wave 4
(GRADE + Summary of Findings #6).

Backlog still open after Wave 4 (docs/08): #7 living-review surveillance, #8 multi-PICO
projects, #13 PRISMA 2020 completeness polish, plus manuscript/table generation, notifications
and OpenSearch from the #9 line — and the "Known follow-ups" below.

### (historical, for reference)

1. **UI wave (task #8)** — pages under `src/app/(app)/projects/[projectId]/`:
   dashboard (GET .../dashboard), protocol editor (+criteria/outcomes/PICO/versions/amendments,
   exclusion reasons), import (upload→preview→commit; sources), dedup (groups, PairCompare,
   merge/reject/undo), screening workspace (queue + CitationCard + i/e/m keyboard shortcuts +
   optimistic advance), conflicts (adjudication dashboard, T/A + FT tabs), fulltext (queue,
   retrieval status, PDF upload/view, FT decisions with required exclusion reason), extraction
   (templates tab: builder; extract tab: study list → dynamic form by field type; conflicts),
   rob (tools tab: builder + clone builtin; assess tab: domain judgments + signaling questions;
   summary traffic-light table), prisma (count boxes + breakdowns + snapshot + export buttons),
   audit (filterable table + before/after DiffViewer), settings (project fields, members/roles,
   invitations, exclusion reasons, exports). Client components fetching via src/lib/api.ts;
   follow existing conventions (org-dashboard.tsx is the exemplar).
2. **Seed** — `prisma/seed.ts` (script wired: `npm run db:seed`): demo per docs/07 §Seed —
   org, 4 users (owner/reviewer1/reviewer2/adjudicator, password `demo-password-123`), project,
   protocol+criteria+outcomes+FT exclusion reasons, 20 citations (2 sources; 3 dup pairs:
   DOI/PMID/fuzzy), dedup resolved, dual blinded T/A decisions with 3 conflicts (2 adjudicated),
   5 to full text, 2 FT exclusions w/ reasons, 3 studies, published extraction template
   (8 fields) + values (1 conflict), builtin RoB tool (call `ensureBuiltinGenericTool()`) +
   2 assessments, PRISMA snapshot. **Seed through the services** (realistic audit trail).
3. **E2E** — `e2e/` Playwright happy path (sign-up → org → project → import RIS → dedup →
   screen → conflict → adjudicate → PRISMA → export) + authz smoke. Config exists.
4. **README.md** — setup/run instructions.
5. **Final review** — /code-review or a review workflow over the whole tree; fix findings.

## Known follow-ups (from implementation agents' reports)

- Protocol: `extractionTemplateId`/`riskOfBiasToolId` not settable via updateProtocol yet —
  needs a small linking endpoint (R9 FK validation). `fromVersion: 0` on amendments before
  first publish = "unpublished draft" (render accordingly). Exclusion reasons are NOT under
  the amendment rule (deliberate).
- Extraction: adjudication finalValue lives ONLY on ExtractionAdjudication — any "final data"
  consumer (exports, future meta-analysis) must prefer adjudicated values. COMPLETED forms are
  editable only on fields with an OPEN conflict (convergence path), re-lock on VOIDED/RESOLVED.
- RoB: signaling responses are not audited (no action in catalog); overall-judgment PATCH
  audited as ROB_JUDGMENT_* with metadata.overall=true; RiskOfBiasConflict uniqueness across
  tools is service-enforced (schema unique lacks toolId).
- Audit actions wanted but mapped to closest-fit + metadata (add to catalog someday):
  extraction.template.archived, extraction.conflict.voided/reopened, rob.conflict.voided,
  rob.response.*, rob.domain.*/question.* (currently ROB_TOOL_UPDATED + metadata.change).
- Reporting: reports_not_retrieved needs an explicit NOT_RETRIEVED latest attempt (zero-attempt
  sought citations count in neither bucket); exports generate in memory (fine for MVP);
  no GET /exports/[jobId] status endpoint (list + download only).
- Invitations list requires project.members capability (emails not exposed to all viewers).

## Conventions locked in (do not drift)

- Services in `src/server/services/<domain>/` take `ctx = {userId}` first arg, check permissions
  via `requirePermission` (capability matrix in src/server/permissions/matrix.ts), mutate inside
  `prisma.$transaction`, write audit via `audit.record(tx, ...)` IN THE SAME TRANSACTION.
- Routes: thin — parseBody(zod) → getCtx() → service → ok()/created(); Next 15 params are a
  Promise. Error envelope { error: { code, message, details } }.
- No client-trusted user IDs. By-id loads tenant-scoped → 404 (R9). Org membership also gates
  project access (R10).
- Blinding: decision reads via visibleDecisionsFor; audit reads via R1 sensitive-entity filter;
  exports R1-gated. Never bypass these in UI or new endpoints.
- Tests: unit colocated `src/**/*.test.ts`; integration in `tests/integration/` (serial, real
  Postgres); exemplars: orgs service/routes/test. Factories in tests/factories.ts.

## Commands

- `docker compose up -d` — Postgres 16 (dev `srb_dev`, test `srb_test`, port **5442**)
- `npm run dev` / `npm run build` / `npm run typecheck`
- `npx prisma migrate dev` / `npm run db:seed` (demo dataset + built-in RoB tool catalog)
- `npm run test:unit` (558) / `npm run test:integration` (255) / `npm test` /
  `npm run e2e` (9) — counts as of the verified Wave 4 milestone
- Env in `.env` (already created; see `.env.example`). AI keys are empty ⇒ `ai.enabled=false`.

## Git

- main, all green at every milestone. No remote configured.
- Wave 4 (GRADE + Summary of Findings) is the current completed milestone. Migrations
  `20260716223319_grade` and `20260717001900_grade_source_fingerprint` are applied to the
  development database.
