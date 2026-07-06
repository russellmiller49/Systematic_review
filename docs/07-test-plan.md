# Test Plan

## Layers

1. **Pure unit tests (Vitest, no DB)** — `src/**/*.test.ts` colocated with the code.
   - Citation parsers: RIS, BibTeX, CSV, NBIB — golden-file fixtures (well-formed exports from
     PubMed/Embase/EndNote/Zotero styles) + malformed inputs (bad tags, missing required fields,
     encoding oddities, multiline abstracts, author list variants). Parse never throws: returns
     `{records, errors}` per row.
   - Dedup engine: normalization (case, diacritics, punctuation, whitespace), exact matchers
     (DOI, PMID, normalized title), fuzzy scorer (title trigram/Jaro-Winkler + author overlap +
     year/journal agreement), grouping into connected components; threshold table-tests.
   - Permission matrix: table-driven — every (role, capability) cell in `05-permissions.md`
     asserted; REMOVED members always false.
   - Conflict logic (pure part): decision-set → conflict? for all combinations of
     INCLUDE/EXCLUDE/MAYBE × `maybeGeneratesConflict` × reviewersPerCitation ∈ {1,2,3}.
   - PRISMA count derivation rules (pure function over an in-memory project state fixture).
   - CSV/JSON export serializers (escaping, column stability).

2. **DB integration tests (Vitest against real Postgres, `srb_test` database)** —
   `tests/integration/*.test.ts`, run serially (`fileParallelism: false`), per-suite truncation.
   - Auth/authz: sign-up, session, 401s; 403 for every capability a role lacks (spot-matrix).
   - Project lifecycle: create → defaults (stages, exclusion reasons) exist; member add/role
     change/soft-remove keeps decisions attributed; invitation accept.
   - Protocol: edit before screening = no amendment; edit after first decision without reason →
     422; with reason → amendment + version increment.
   - Import: RIS/BibTeX/CSV upload → preview rows (incl. row errors) → commit → citations +
     source records + identifiers; recommit blocked.
   - Dedup: seeded exact/fuzzy duplicates → candidates with evidence; merge preserves source
     records + sets duplicateOf; reject; undo restores; PRISMA duplicate count reflects merges.
   - Screening: assignment strategies; my-queue excludes decided; **blinding: reviewer B's GET
     never contains reviewer A's decision while blinded** (the key leak test); decisions upsert;
     change writes audit with previousValue; conflict opens exactly when required decisions
     disagree; no conflict on agreement; MAYBE behavior per config; adjudication resolves,
     requires reason, records adjudicator, leaves original decisions untouched.
   - Full text: upload (hash, storage key), link, retrieval attempts; FT exclude without reason →
     422; with reason → ok.
   - Extraction: template publish freezes; value upsert validates by field type; edit preserves
     previous value in audit; dual completion → conflict on mismatch; adjudication.
   - RoB: tool builder; judgment upsert + change audit; dual assessment conflict; adjudication.
   - PRISMA: full seeded pipeline → every count key asserted against hand-computed values.
   - Audit: every mutating endpoint leaves expected event(s) (helper:
     `expectAudit(action, entityId)`); audit query filters work.
   - Exports: each kind × format produces parseable output with expected row counts.

3. **E2E smoke (Playwright)** — `e2e/*.spec.ts` against `next dev` + seeded DB.
   - Sign up → create org → create project → import RIS fixture → dedup merge → screen 3
     citations with keyboard → second reviewer disagrees → adjudicate → PRISMA numbers visible →
     export JSON. One long happy-path spec plus an authz smoke (observer sees no action buttons,
     direct POST → 403).

## Infrastructure

- `docker compose up -d db` provides `srb_dev` and `srb_test` databases (init script).
- Integration tests run migrations once (`prisma migrate deploy`) then truncate between suites.
- Factories in `tests/factories.ts` (user, org, project-with-members, citations) — no test relies
  on the demo seed.
- `npm test` = unit + integration; `npm run test:unit` skips DB; `npm run e2e` runs Playwright.
- CI order: typecheck → unit → integration → build → e2e.

## Seed / demo dataset (`prisma/seed.ts`)

Exactly the spec's demo: 1 org, 4 users (owner+2 reviewers+1 adjudicator — adjudicator doubles
as extractor), 1 project (SR with meta-analysis, dual blinded screening), protocol with criteria
+ outcomes + FT exclusion reasons, 20 citations across 2 sources (PubMed RIS + Embase CSV) with
3 duplicate pairs (1 DOI-exact, 1 PMID-exact, 1 fuzzy-title), dedup resolved, dual T/A decisions
with 3 conflicts (2 adjudicated, 1 open), 5 citations to full text, 2 FT exclusions with
reasons, 3 included studies, published extraction template (8 fields), extraction values for 2
studies (1 field conflict), generic RoB tool assessment for 2 studies, and one PRISMA snapshot.
All seeded through the **service layer** so the audit trail is realistic, not synthetic.
