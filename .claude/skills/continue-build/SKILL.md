---
name: continue-build
description: Resume building the Synthesis systematic-review platform MVP in this repo. Use when the user asks to continue building, finish the MVP, build the UI pages, write the seed, add E2E tests, or pick up where the last session left off.
---

# Continue building Synthesis (systematic-review platform MVP)

## Load context first (in this order, before writing any code)

1. `docs/STATUS.md` — current state, remaining work, known follow-ups. This is authoritative.
2. `docs/09-design-review-resolutions.md` — binding policies R1–R18 (blinding, locks,
   lifecycle, tenancy). Never violate these.
3. `prisma/schema.prisma` — the data model (treat as frozen; migrations only with good reason).
4. Conventions exemplars: `src/server/services/orgs/index.ts`, `src/app/api/orgs/**`,
   `tests/integration/orgs.test.ts`, and for UI: `src/components/orgs/org-dashboard.tsx`,
   `src/components/projects/new-project-dialog.tsx`, `src/components/citations/citation-card.tsx`.

## State when this skill was written

All backend services and ~70 API routes are DONE and green (96 unit + 140 integration tests,
tsc clean, next build green, committed). The UI shell (auth pages, org pages, project sidebar)
is done. Remaining, in order — see STATUS.md "Remaining work" for full detail:

1. The 12 project workspace pages under `src/app/(app)/projects/[projectId]/` (task #8 in the
   task list). Client components fetching the existing REST API via `src/lib/api.ts`
   (`api/apiPost/apiPatch/apiPut/apiDelete`), UI kit in `src/components/ui/`, PageHeader/StatCard
   in `src/components/layout/page-header.tsx`. Screening page must be keyboard-first
   (i=include, e=exclude, m=maybe, ?=help) with optimistic queue advance. Full-text exclusion
   UI must require an exclusion reason. Loading skeletons + EmptyState everywhere.
2. `prisma/seed.ts` — demo dataset per `docs/07-test-plan.md` §Seed, created THROUGH the
   services (imports service for citations, screening service for decisions, etc.) so the audit
   trail is realistic. `ensureBuiltinGenericTool()` from `src/server/services/rob/builtin.ts`
   seeds the built-in RoB tool. Demo accounts: owner@demo.test, reviewer1@demo.test,
   reviewer2@demo.test, adjudicator@demo.test / `demo-password-123`.
3. Playwright E2E happy path in `e2e/` (config exists; `npx playwright install` may be needed).
4. `README.md` (setup: docker compose up -d, cp .env.example .env + secret, migrate, seed, dev).
5. Final code review over the tree; fix confirmed findings.

## How to work

- Environment: Postgres via `docker compose up -d` (port 5442). `.env` already exists.
- Verify loop: `npm run typecheck && npm run test:unit && npm run test:integration`, then
  `npx next build`. All were green at handoff — keep them green.
- For the UI wave, parallel subagents work well: this skill authorizes using the Workflow tool
  to fan out page-building agents (one per page group, disjoint files, each forbidden from
  touching shared files — see the pattern in the session's implement-domains workflow script if
  available). Give each agent: the exact endpoints it consumes (grep the route files), the
  exemplar components, and the rule that services/routes are read-only for them.
- UI pages must never work around blinding: render only what the API returns.
- Commit per milestone with the trailer:
  `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`
- Update `docs/STATUS.md` and the task list as milestones complete.

## Acceptance target

The 17-step acceptance checklist in `docs/08-milestones.md` — a user can go from sign-up to
export entirely through the UI, with the demo seed showcasing every feature.
