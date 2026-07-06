# Build Status (living document — updated after every milestone)

> Purpose: durable progress anchor. If you are resuming work on this repo, read this first,
> then docs/09-design-review-resolutions.md (the implementation contract), then docs/01–08.
> There is a continuation skill: `.claude/skills/continue-build/SKILL.md`.

## Current state (2026-07-05)

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

## Remaining work (in order)

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
- `npx prisma migrate dev` / `npm run db:seed` (seed not yet written)
- `npm run test:unit` (96) / `npm run test:integration` (140) / `npm test` / `npm run e2e`
- Env in `.env` (already created; see `.env.example`)

## Git

- main @ 26bf96c (all green). No remote configured.
