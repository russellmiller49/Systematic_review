# Build Status (living document — updated after every milestone)

> Purpose: durable progress anchor. If you are resuming work on this repo, read this first,
> then docs/01–08 for the plan.

## Current state

- **M1 Plan**: ✅ docs 01–08 + 09 (design-review resolutions — READ IT, it is the implementation
  contract for lifecycle/blinding/security policies). Adversarial review done: 32 confirmed
  findings, all resolved in schema + docs/09.
- **M2 Scaffold**: ✅ Next.js 15 + TS strict + Tailwind v4 + owned UI kit (src/components/ui),
  docker Postgres (5442, srb_dev + srb_test), Prisma migrated (init), Auth.js credentials
  (sign-up/sign-in working), errors/api-utils/permissions/audit-service backbone, Vitest unit +
  integration infra (tests/), matrix unit tests green, `next build` green.
- **M3 Core domain**: not started
- **M4 Import & dedup**: not started
- **M5 Screening**: not started
- **M6 Full text**: not started
- **M7 Extraction & RoB**: not started
- **M8 PRISMA/exports/demo**: not started

## Conventions locked in

- Services in `src/server/services/<domain>/` take `ctx = {userId}` first arg, check permissions
  via `requirePermission`, mutate inside `prisma.$transaction`, write audit via `audit.record(tx, ...)`.
- Route handlers: Zod parse → session → service → `{data}` / `{error:{code,message}}` envelope.
- No client-trusted user IDs; actor always from session.
- Tests: unit colocated `*.test.ts`; integration in `tests/integration/` (serial, real Postgres
  `srb_test`); E2E in `e2e/`.

## Commands

- `docker compose up -d` — Postgres 16 (dev db `srb_dev`, test db `srb_test`)
- `npm run dev` / `npm run build`
- `npx prisma migrate dev` / `npm run db:seed`
- `npm run test:unit` / `npm run test:integration` / `npm test` / `npm run e2e`

## Demo accounts (after seed)

See prisma/seed.ts — owner@demo.test / reviewer1@demo.test / reviewer2@demo.test /
adjudicator@demo.test, password: `demo-password-123`
