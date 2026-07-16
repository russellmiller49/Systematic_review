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
5. Meta-analysis module (effect measures, forest/funnel, R export)
6. GRADE per outcome + SoF tables
7. Living-review surveillance (saved searches → new ImportBatches → triage queue)
8. Multi-PICO projects (`picoQuestionId` FKs)
9. Cohort-overlap detection; manuscript/table generation; notifications; OpenSearch
