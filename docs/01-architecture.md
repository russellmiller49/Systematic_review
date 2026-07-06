# System Architecture

## Product

An evidence synthesis operating system ("Synthesis") for systematic reviews and meta-analyses.
Core principle: **every decision, data point, analysis, and conclusion is traceable back to the
source evidence and the human judgment that produced it.**

## Stack decision

| Layer | Choice | Rationale |
|---|---|---|
| App framework | **Next.js 15 (App Router) + TypeScript (strict)** | One language across the stack; server components for data-heavy pages; route handlers give a testable REST API surface. |
| UI | **Tailwind CSS v4 + shadcn/ui-style component kit** | Fast, accessible, professional; components are owned files, not a dependency. |
| API | **Next.js Route Handlers (`/api/...`)** | Explicit REST surface (testable with plain `fetch`, usable by future non-web clients), thin controllers over a framework-agnostic service layer. No separate FastAPI service: a second language/runtime buys nothing at MVP scale and doubles deployment complexity. The service layer is the extraction seam if a Python statistics service (meta-analysis, R integration) is added later. |
| Database | **PostgreSQL 16 (Docker Compose locally)** | As specified. Normalized schema, FTS-ready (`pg_trgm`, `tsvector` later). |
| ORM | **Prisma 6** | Migrations, strict typed client, readable schema file that doubles as the data-model document. |
| Auth | **Auth.js (NextAuth v5) with credentials provider, JWT sessions** | Email+password for MVP; OAuth/SSO providers slot in later without schema changes. Passwords hashed with bcrypt. |
| File storage | **`FileStorage` interface → `LocalDiskStorage` (dev)** | S3-compatible implementation is a drop-in later; all callers depend on the interface only. |
| Background jobs | **None in MVP; `JobRunner` seam in services** | MVP import/dedup volumes (≤ tens of thousands of rows) run inline in the request within a transaction. Services are written as pure async functions so a BullMQ worker can call them unchanged. |
| Search | **SQL filters + Postgres ILIKE/trigram** | OpenSearch later; queries are isolated in repository functions. |
| Testing | **Vitest (unit + DB integration), Playwright (E2E smoke)** | See `07-test-plan.md`. |
| Validation | **Zod** at every API boundary; parsed types flow into services. |

## Module layout

Single app, strict internal layering. **Domain logic lives in `src/server/services/` and never in
components or route handlers.** Route handlers do: parse (Zod) → authenticate → call service →
serialize. Services do: authorize (permission check) → validate invariants → mutate in a
transaction → write audit events **in the same transaction**.

```
src/
  app/                      # Next.js App Router (pages + route handlers)
    (auth)/                 # sign-in, sign-up
    (app)/projects/[projectId]/...   # all project workspaces
    api/                    # REST route handlers (thin controllers)
  components/
    ui/                     # owned shadcn-style primitives
    <domain>/               # screening/, dedup/, extraction/ ... feature components
  server/
    auth/                   # Auth.js config, session helpers
    db.ts                   # Prisma client singleton
    permissions/            # role → capability matrix, requirePermission()
    services/               # ONE subdirectory per domain (the heart of the app)
      audit/  orgs/  projects/  protocols/  imports/  citations/  dedup/
      screening/  fulltext/  extraction/  rob/  prisma-report/  exports/
    storage/                # FileStorage interface + LocalDiskStorage
    validation/             # shared Zod schemas (request DTOs)
  lib/                      # pure utilities (shared client/server)
```

### Domain map (18 domains from the spec)

| Domain | MVP status | Where |
|---|---|---|
| 1. Auth & users | ✅ full | `server/auth`, `services/users` |
| 2. Organizations/workspaces | ✅ full | `services/orgs` |
| 3. Projects | ✅ full | `services/projects` |
| 4. Protocols | ✅ full (structured editor + versioning + amendments) | `services/protocols` |
| 5. Search/import sources | ✅ (RIS/BibTeX/CSV/NBIB parsing, source tracking) | `services/imports` |
| 6. Citations | ✅ full | `services/citations` |
| 7. Deduplication | ✅ (exact + fuzzy, merge/reject/undo) | `services/dedup` |
| 8. Screening | ✅ (dual blinded T/A, conflicts, adjudication) | `services/screening` |
| 9. Full text / PDFs | ✅ (upload, link, retrieval attempts, FT screening) | `services/fulltext`, `server/storage` |
| 10. Data extraction | ✅ (template builder, forms, values, dual + conflicts) | `services/extraction` |
| 11. Risk of bias | ✅ (custom tools + built-in generic, dual + conflicts) | `services/rob` |
| 12. PRISMA reporting | ✅ (live counts, snapshots, CSV/JSON export) | `services/prisma-report` |
| 13. Meta-analysis | ⛳ extension point | `Study`/`ExtractionValue` schema designed for outcome data; service slot reserved |
| 14. GRADE | ⛳ extension point | `OutcomeDefinition` is the future anchor entity |
| 15. Audit trail | ✅ full | `services/audit` (cross-cutting) |
| 16. Notifications | ⛳ extension point | audit events are the future event source |
| 17. Exports | ✅ (CSV/JSON of citations, decisions, extraction, PRISMA, audit) | `services/exports` |
| 18. AI assistant layer | ⛳ extension point | see "AI seams" below |

## Extension seams for advanced features (designed now, built later)

- **AI-assisted screening/extraction**: every human decision table is human-only. AI output will
  live in separate `*Suggestion` tables (`ScreeningSuggestion`, `ExtractionSuggestion`) keyed to
  the same entities, with model/version/confidence columns. Nothing in the MVP reads or writes
  merged human+AI state, so adding suggestion tables is purely additive.
  `ExtractionValue.sourceAnchor` (JSON) already reserves the source-anchoring slot
  (page/paragraph/table-cell coordinates into a `FullTextFile`).
- **Meta-analysis / GRADE**: `Study` (not `Citation`) is the analysis unit; extraction values are
  typed JSON keyed by field definitions, so outcome data can be assembled per
  `OutcomeDefinition`. A future `analysis` service (or Python sidecar) consumes these tables
  read-only.
- **Cohort-overlap detection**: `Study` ↔ `StudyReportLink` ↔ `Citation` already models
  many-reports-per-study; overlap detection adds candidate links, reusing the dedup
  candidate/review pattern.
- **Living review**: `ImportBatch`/`ImportSource` model repeated imports natively; a surveillance
  job creates new batches and the triage queue is the existing screening queue filtered by batch.
- **Multi-PICO**: `PICOQuestion` is its own table (not columns on Protocol); screening decisions,
  templates, and criteria gain an optional `picoQuestionId` FK later. MVP keeps a single implicit
  PICO per project.
- **Search-strategy validation & manuscript generation**: consume existing tables read-only.

## Data integrity rules → enforcement points

| Rule | Enforcement |
|---|---|
| 1. Never delete source records during dedup | Merge sets `Citation.status=DUPLICATE` + `duplicateOfId`; `CitationSourceRecord` rows are immutable; no delete path exists. |
| 2. Never overwrite human decisions with AI | No AI write paths in MVP; future suggestions live in separate tables. |
| 3. Protocol changes after screening starts require amendment | `protocols.service` checks `screeningHasBegun(projectId)`; edits then require an `amendmentReason` and create `ProtocolAmendment` + new `ProtocolVersion`. |
| 4. No full-text exclusion without reason | DB: `ScreeningDecision` CHECK-style validation in service + API Zod refinement; UI requires reason picker. |
| 5. No adjudication without adjudicator | `adjudicatorId` NOT NULL FK; taken from session, never from request body. |
| 6. Extraction edits preserve prior values | `ExtractionValue` updates write `AuditEvent(previousValue, newValue)` in the same transaction. |
| 7. Role changes audited | `projects.service.updateMemberRoles` writes audit event in same transaction. |
| 8. Study-level vs report-level separation | Distinct `Study` and `Citation` tables joined by `StudyReportLink`. |

## Cross-cutting: audit in the same transaction

All mutating service functions accept a Prisma transaction client and call
`audit.record(tx, {...})`. There is no code path where a domain mutation commits without its audit
event (see `06-audit-design.md`).

## Deployment shape

- **Dev**: `docker compose up db` + `next dev`; uploads to `./storage/uploads`.
- **Prod (later)**: containerized Next.js, managed Postgres, S3 storage driver, BullMQ worker
  container. No architectural change required.
