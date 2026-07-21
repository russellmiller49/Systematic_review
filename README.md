# Synthesis

A systematic-review and meta-analysis platform for medical research teams. Synthesis takes a
review from protocol registration through search import, deduplication, blinded dual screening,
full-text retrieval, data extraction, risk-of-bias assessment, and a live PRISMA 2020 flow — with
a complete, blinding-aware audit trail at every step.

Built with Next.js 15 (App Router) · React 19 · TypeScript (strict) · Tailwind v4 · Prisma ·
PostgreSQL · Auth.js.

The in-product [user guide](http://localhost:3000/guide) includes a searchable workflow,
role guidance, screening shortcuts, troubleshooting, and a narrated captioned overview of the
seeded demo project.

## What it does

- **Organizations & projects** — multi-tenant workspaces with per-project role-based permissions
  (owner, reviewer, adjudicator, extractor, statistician, librarian, …).
- **Protocol** — background, PICO, eligibility criteria, outcomes, and full-text exclusion
  reasons. Publishing snapshots a version; once screening begins, every change requires a
  recorded amendment.
- **Import** — RIS, BibTeX, CSV, and NBIB parsers with per-row error reporting and a
  preview-then-commit flow, tracked by source.
- **Deduplication** — exact (DOI/PMID/normalized-title) and fuzzy (Jaro-Winkler composite)
  detection, side-by-side pair comparison, merge with undo.
- **Screening** — keyboard-first, blinded dual review. Reviewers see only their own decisions;
  disagreements open conflicts for an adjudicator. Stage results are materialized so PRISMA and
  the full-text queue stay consistent.
- **Full text** — retrieval tracking, PDF upload (magic-byte validated, content-addressed) and
  inline serving, and full-text screening where exclusions require a reason.
- **Extraction** — build versioned extraction templates with typed fields, extract in parallel,
  and adjudicate field-level conflicts. Adjudicated values are authoritative for export.
- **Risk of bias** — built-in tools for the standard instruments (RoB 2, ROBINS-I, QUADAS-2,
  Newcastle-Ottawa, JBI RCT checklist, AMSTAR 2) plus a generic domain tool — clone & customize,
  or build your own. Domain + overall judgments validated against each tool's scale, conflict
  adjudication, and a traffic-light summary.
- **PRISMA & exports** — live PRISMA 2020 counts rendered as the PRISMA 2020 flow diagram
  (downloadable as SVG/PNG for manuscripts, also for frozen snapshots), plus CSV/JSON exports
  (citations, screening, extraction, RoB, PRISMA, audit) gated by capability.
- **Audit trail** — every mutation is recorded with before/after values; sensitive
  (blinding-relevant) events are filtered by capability so a blinded reviewer never sees a
  co-reviewer's decisions.

## Prerequisites

- Node.js 20+
- Docker (for the PostgreSQL container), or a PostgreSQL 16 instance you point `DATABASE_URL` at

## Quick start

```bash
# 1. Install dependencies
npm install

# 2. Start PostgreSQL (dev + test databases, port 5442)
docker compose up -d

# 3. Configure environment
cp .env.example .env
# then set AUTH_SECRET to a real value:
#   openssl rand -base64 32   →   paste into AUTH_SECRET in .env

# 4. Apply the schema
npm run db:migrate

# 5. Seed the demo dataset (see below)
npm run db:seed

# 6. Run the app
npm run dev
```

Open http://localhost:3000 and sign in with a demo account.

## Demo accounts

`npm run db:seed` builds a complete, realistic review — *"Endobronchial valves for severe
emphysema: a systematic review and meta-analysis"* — entirely through the service layer, so the
audit trail is authentic. It contains 20 imported citations across two sources (PubMed RIS +
Embase CSV), 3 duplicate pairs (DOI-exact, PMID-exact, fuzzy-title) already resolved, blinded
dual title/abstract screening with three conflicts (two adjudicated, one still open), five
citations advanced to full text (three included, two excluded with reasons), dual extraction
with an adjudicated field conflict, dual risk-of-bias assessment with an adjudicated domain
conflict, and a PRISMA snapshot.

| Email | Password | Role in the demo project |
|---|---|---|
| `owner@demo.test` | `demo-password-123` | Owner / administrator |
| `reviewer1@demo.test` | `demo-password-123` | Reviewer + extractor |
| `reviewer2@demo.test` | `demo-password-123` | Reviewer + extractor |
| `adjudicator@demo.test` | `demo-password-123` | Adjudicator |

Sign in as different users to see blinding in action: as a reviewer you see only your own
screening decisions and the audit events you're entitled to; as the adjudicator or owner you see
the conflicts and the full history.

> **Note:** `npm run db:seed` resets the dev database before seeding.

## Testing

```bash
npm run typecheck        # tsc --noEmit
npm run test:unit        # Vitest unit tests (pure logic, colocated)
npm run test:integration # Vitest integration tests (real Postgres, serial)
npm run build            # next build
npm run e2e              # Playwright end-to-end (needs: npx playwright install)
```

The integration tests use the `srb_test` database (created automatically by the Docker
container). CI order: typecheck → unit → integration → build → e2e.

## Project layout

```
src/
  app/
    (auth)/            Sign-in / sign-up
    (app)/             Authenticated shell: orgs, projects, and the 12 project workspace pages
    api/               ~70 REST routes (thin wrappers over services)
  server/
    services/<domain>/ Domain logic: permission check → transaction → audit, all in one place
    permissions/       Capability matrix (the authoritative access-control rules)
    auth/ db/ errors/  Auth.js, Prisma client, error envelope
  components/
    ui/                Owned UI kit (button, dialog, table, tabs, …)
    <domain>/          Feature components for each workspace page
prisma/
  schema.prisma        Data model
  seed.ts              Demo dataset (through the services)
docs/                  Architecture, data model, API/permissions/audit design, test plan (01–09)
e2e/                   Playwright specs
```

## Configuration

| Variable | Purpose |
|---|---|
| `DATABASE_URL` | PostgreSQL connection for the app (dev: `srb_dev`) |
| `TEST_DATABASE_URL` | PostgreSQL connection for integration tests (`srb_test`) |
| `AUTH_SECRET` | Auth.js JWT secret — generate with `openssl rand -base64 32` |
| `AUTH_TRUST_HOST` | `true` for local development |
| `STORAGE_DIR` | Local directory for uploaded full-text PDFs |
| `PILOT_EMAIL_ALLOWLIST` | Optional comma-separated signup allowlist; active organization or project invitations are also accepted |
| `AI_PROVIDER` + provider key | Optional AI prescreening/extraction provider; no key disables AI features |

## Pilot deployment

The recommended pilot target is Railway: one persistent Node service, one managed PostgreSQL
service, and one volume mounted at `/data` for uploaded PDFs. The checked-in `railway.toml`
runs migrations and the safe built-in-tool bootstrap before each deploy, then gates traffic on
`/api/health`.

See [docs/10-pilot-deployment.md](docs/10-pilot-deployment.md) for the exact provisioning,
deployment, access, backup, and rollback workflow. Do **not** run `npm run db:seed` against the
pilot database; the demo seed intentionally resets its target database.

## Design contract

`docs/09-design-review-resolutions.md` records the binding policies (R1–R18) that came out of an
adversarial design review — blinding rules, decision/lock lifecycle, tenancy scoping, upload
validation, and more. `docs/STATUS.md` tracks build progress. These are the first things to read
before changing behavior.

## Security posture (MVP)

Standard defensive hardening for a multi-tenant app: every by-id load is tenant-scoped (404 on
mismatch), org membership gates project access, passwords are bcrypt (cost 12, ≥10 chars),
uploads are PDF-only (server sniffs magic bytes, 50 MB cap) and served with `nosniff`, and
invitation tokens are single-use and returned only once. Rate limiting and password-reset are
deferred to the deployment layer (documented in `docs/09`).
