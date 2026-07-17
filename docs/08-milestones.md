# Development Milestones

Mirrors the requested phases; each milestone ends green (typecheck + tests pass).

| # | Milestone | Contents | Exit criteria |
|---|---|---|---|
| M1 | Plan | docs/01–08, Prisma schema draft, adversarial design review | Review findings resolved; schema frozen for M2 |
| M2 | Scaffold | Next.js 15 + TS strict + Tailwind v4 + ui kit; docker-compose (dev+test DBs); Prisma migrate; Auth.js credentials (sign-up/in/out); base layout; Vitest + Playwright wiring | Sign-up→sign-in works locally; `npm test` green |
| M3 | Core domain | Orgs, projects (+creation wizard fields), members/roles/invitations, permission matrix, audit service, protocol builder (fields, criteria, outcomes, PICO, versions, amendments), exclusion reasons | Integration tests for authz, project lifecycle, protocol amendments |
| M4 | Import & dedup | RIS/BibTeX/CSV/NBIB parsers, preview→commit flow, sources, citations+identifiers+source records, exact+fuzzy dedup, merge/reject/undo, dedup UI | Parser golden tests; dedup integration tests; import UI usable |
| M5 | Screening | Stages, assignment, queue API, decision upsert, blinding, conflict generation, adjudication API, screening workspace UI (keyboard), conflicts dashboard | Blinding leak test green; conflict matrix tests green |
| M6 | Full text | File storage abstraction, PDF upload/link/stream, retrieval attempts, FT screening with required reasons, FT conflicts | FT exclusion-reason enforcement tests |
| M7 | Extraction & RoB | Template/field builder + publish, forms, typed values (+quote/page/anchor slot), dual extraction conflicts + adjudication; RoB tools/domains/questions, assessments, judgments, dual conflicts | Extraction + RoB integration tests |
| M8 | PRISMA, exports, demo | Live PRISMA service + dashboard, snapshots, CSV/JSON exports (citations/screening/extraction/rob/prisma/audit), full demo seed, E2E happy path | PRISMA counts test vs hand-computed; E2E green; acceptance checklist walk-through |

## Acceptance checklist (from spec)

Create account → create project → add reviewers → build protocol → import RIS/BibTeX/CSV →
dedup → assign blinded dual screening → screen T/A → resolve conflicts → upload full texts → FT
screen with reasons → PRISMA counts → custom extraction form → extract → RoB assessment → audit
history → export. Each maps to at least one integration or E2E test.

## Post-MVP backlog (ordered)

1. ~~PRISMA 2020 diagram rendering~~ ✅ 2026-07-12 — SVG diagram on the PRISMA page (live +
   snapshots), downloadable as SVG/PNG (`src/components/prisma/diagram-layout.ts`)
2. ~~Built-in RoB 2 / ROBINS-I / QUADAS-2 / NOS / JBI / AMSTAR-2 tool seeds~~ ✅ 2026-07-12 —
   `ensureBuiltinStandardTools()` (`src/server/services/rob/standard-tools.ts`), seeded by
   `npm run db:seed`
3. ~~AI screening suggestions (separate tables) + active-learning ranking~~ ✅ 2026-07-14 —
   `ScreeningSuggestion`/`AiScreeningRun` + provider Batch API runs + queue score badges and
   score-ranked ordering (`src/server/services/ai-screening`, `src/server/ai/`)
4. ~~AI extraction with source anchoring (anchor slot exists)~~ ✅ 2026-07-14 —
   `ExtractionSuggestion`/`AiExtractionRun` + per-field Apply through `upsertValue`
   (`appliedSuggestionId`), which now populates `ExtractionValue.sourceAnchor`
5. Meta-analysis module — **phase A ✅ 2026-07-16** (binary RR/OR/RD + continuous MD/SMD,
   fixed IV + DerSimonian-Laird pooling, scipy-pinned golden fixtures, field-role mapping over
   adjudicated>consensus>single values, live forest plot with SVG/PNG download —
   `src/lib/stats/`, `src/server/services/analysis/`, `src/components/analysis/`);
   **phase B ✅ 2026-07-16** (single-arm proportions with logit/Freeman–Tukey transforms +
   harmonic-mean back-transform, generic inverse variance with CI→SE, prediction intervals,
   Egger's test + funnel plot, "Generate outcome fields" template scaffold, ANALYSIS
   export kind). Remaining: R script export (unplanned; CSV/JSON export covers the data)
6. ~~GRADE per outcome + SoF tables~~ ✅ 2026-07-16 — deterministic five-domain Tier-1 rules
   with an audited draft/edit/review workflow, caller-independent final-only inputs and
   source/context freshness protection, optional version-bound AI suggestions requiring human
   application, Summary of Findings table + CSV, and GRADE export (`src/lib/grade/`,
   `src/server/services/grade/`, `src/components/analysis/`); starting level remains manual and
   audited (`AnalysisRole.STUDY_DESIGN` deliberately unwired)
7. Living-review surveillance (saved searches → new ImportBatches → triage queue)
8. Multi-PICO projects (`picoQuestionId` FKs)
9. ~~Cohort-overlap detection~~ ✅ 2026-07-16 (NBIB/RIS affiliation + registry-ID capture
   with lazy raw-record backfill, two-tier scoring engine, link/reject with guarded study
   merge, "Companions" tab — `src/server/services/cohort/`); still open from this line:
   manuscript/table generation; notifications; OpenSearch
10. ~~AI risk-of-bias suggestions with quoted evidence~~ ✅ 2026-07-16 —
    `RobSuggestion`/`AiRobRun` + per-domain Apply through `applySuggestion`
    (`src/server/services/ai-rob`, prompt `rob-v1`)
11. ~~Cross-study extraction table (living table, phase 1)~~ ✅ 2026-07-16 — resolved
    matrix (adjudicated > agreed > single) + evidence popovers + click-to-page PDF dialog
    + CSV export (`src/server/services/extraction/matrix.ts`, extraction "Table" tab)
12. ~~Evidence anchoring~~ ✅ 2026-07-16 — phase 2 (pdfjs evidence viewer with quote
    highlighting via `src/lib/quote-match.ts`, wired into the extraction form quote blocks and
    the matrix Table tab, iframe fallback behind an error boundary — `src/components/pdf/`)
    and phase 3 (server text layer `FullTextPage` + anchor v2 with char offsets into stored
    text, AI-ingest + manual-save + select-in-PDF producers, audited re-anchor backfill with
    coverage report — `src/server/services/fulltext-pages/`, `src/types/source-anchor.ts`)
13. PRISMA 2020 completeness polish (registers/"other methods" arms, awaiting-classification
    bucket) — counts themselves are already fully automatic
