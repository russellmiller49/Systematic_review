# Build Status (living document — updated after every milestone)

> Purpose: durable progress anchor. If you are resuming work on this repo, read this first,
> then docs/09-design-review-resolutions.md (the implementation contract), then docs/01–08.
> There is a continuation skill: `.claude/skills/continue-build/SKILL.md`.

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

**None for MVP**, and post-MVP backlog items 1–4 (PRISMA diagram, built-in RoB tool catalog,
AI prescreening, AI extraction) are ✅ done (2026-07-12 and 2026-07-14 states above). Next up
in docs/08: meta-analysis (#5), GRADE (#6), … — plus the "Known follow-ups" below remain open.

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
- `npm run test:unit` (111) / `npm run test:integration` (146) / `npm test` / `npm run e2e` (5)
- Env in `.env` (already created; see `.env.example`)

## Git

- main, all green at every commit. No remote configured.
