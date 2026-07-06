# Data Model

The authoritative schema is [`prisma/schema.prisma`](../prisma/schema.prisma). This document
records the **decisions** behind it. All IDs are `cuid()` strings; all rows carry
`createdAt`/`updatedAt` where meaningful. All project-scoped tables carry `projectId` for
tenancy filtering and indexing.

## Users & teams

- `User` — email (unique, citext-like lowercased in service), name, passwordHash. No org data on
  the user row.
- `Organization` / `OrganizationMember(role: OWNER|ADMIN|MEMBER)` — workspaces. Projects belong
  to an organization.
- `Project` — title, reviewType (7 supported types), researchQuestion, description, status,
  registrationPlatform/registrationId, and screening config lives on `ScreeningStage` rows (not
  on Project) so title/abstract and full-text stages can differ.
- `ProjectMember` — `roles ProjectRole[]` (a person is often both REVIEWER and ADJUDICATOR),
  `status: ACTIVE|REMOVED`. **Removal is a status flip**; every decision table references
  `userId` directly, so removing a collaborator never orphans or deletes their work.
- `ProjectInvitation` — email, roles, token, expiresAt, acceptedAt.

Project roles: `OWNER, ADMIN, REVIEWER, ADJUDICATOR, EXTRACTOR, STATISTICIAN, LIBRARIAN,
PANEL_MEMBER, TRAINEE, OBSERVER` (capability matrix in `05-permissions.md`).

## Protocol

- `Protocol` — 1:1 with project. Structured narrative fields (background, reviewQuestion,
  population, intervention, comparator, setting, studyDesigns[], dateRestrictions,
  languageRestrictions[], databases[], grayLiteratureSources[], subgroupPlan, sensitivityPlan,
  metaAnalysisPlan, gradePlan).
- Child tables: `PICOQuestion` (ordered; MVP uses one, multi-PICO ready),
  `EligibilityCriterion(type: INCLUSION|EXCLUSION)` — one table for the spec's
  InclusionCriterion/ExclusionCriterion since they differ only by polarity, `OutcomeDefinition`
  (name, type PRIMARY|SECONDARY, measure, timepoint — future GRADE anchor). The spec's
  `ScreeningRule` lives as config on `ScreeningStage` (reviewersPerCitation, blinded,
  maybeGeneratesConflict) — one operational source of truth; protocol version snapshots capture
  the stage config at publish time so the *planned* rules are still versioned.
- `ExclusionReason` — project-scoped list, `stage: TITLE_ABSTRACT|FULL_TEXT|BOTH`, protocol-derived,
  orderable. Full-text exclusions **must** reference one.
- Extraction fields and RoB tool config are first-class in their own domains
  (`ExtractionTemplate`, `RiskOfBiasTool`); `Protocol` references them
  (`extractionTemplateId?`, `riskOfBiasToolId?`) — this satisfies the spec's
  `ExtractionFieldDefinition`/`RiskOfBiasToolConfig` without duplicating structures.
- `ProtocolVersion` — immutable full-JSON snapshot (protocol + children), monotonically numbered.
  Created on publish and on every amendment.
- `ProtocolAmendment` — reason (required), description, fromVersion→toVersion, author. Service
  refuses post-screening-start edits without one.

## Imports & citations

- `ImportSource` — per-project named source (PubMed, Embase, CENTRAL, hand search…); PRISMA's
  "records by source" comes from here.
- `ImportBatch` — file name, format (`RIS|BIBTEX|CSV|NBIB`), status
  `PREVIEWED|COMMITTED|FAILED`, counts (total/parsed/failed), uploader. Two-step import:
  parse+preview (batch stored with parsed rows) → commit (citations created).
- `Citation` — the **report**: title, authors (JSON array of `{family, given, raw}`), year,
  journal, volume, issue, pages, abstract, doi, pmid, url, language. Plus `status:
  ACTIVE|DUPLICATE`, `duplicateOfId` (self-FK; set by merge, cleared by undo), and normalized
  columns (`normalizedTitle`, `normalizedDoi`) maintained by the service for dedup/index use.
- `CitationSourceRecord` — **immutable** raw record per import (rawRecord text + parsed JSON +
  batch FK). A merged duplicate keeps its source records; nothing is ever discarded.
- `CitationIdentifier` — `(type: DOI|PMID|PMCID|URL|ISBN|REGISTRY_ID|OTHER, value)`, unique per
  citation+type. DOI/PMID also denormalized onto Citation for fast dedup.
- `Study` + `StudyReportLink(studyId, citationId, isPrimaryReport)` — a Study is created when a
  citation is included at full text (or manually); multiple citations (reports) can link to one
  study. **Extraction and RoB attach to Study, never Citation.**

## Deduplication

- `DeduplicationCandidate` — a **pair** `(citationAId < citationBId)`, method
  (`EXACT_DOI|EXACT_PMID|NORMALIZED_TITLE|FUZZY`), score (0–1), `reasons` JSON (human-readable
  evidence: matched fields, similarity values), status `SUGGESTED|MERGED|REJECTED`, decidedBy,
  decidedAt. Unique on the pair.
- `DeduplicationGroup` + member link — clusters candidates for the review UI (connected
  components of SUGGESTED pairs).
- Merge = pick canonical citation; others get `status=DUPLICATE`, `duplicateOfId=canonical`;
  identifiers/source-records are **linked, never moved or deleted**; PRISMA "duplicates removed"
  counts `status=DUPLICATE`. Undo restores `ACTIVE` and re-opens the candidate. All three
  transitions are audited.

## Screening

- `ScreeningStage` — per project, `type: TITLE_ABSTRACT|FULL_TEXT`, config
  (reviewersPerCitation, blinded, maybeGeneratesConflict), status.
- `ScreeningAssignment` — (stage, citation, reviewer, status `PENDING|COMPLETED`). Queue = my
  PENDING assignments. Unique (stageId, citationId, reviewerId).
- `ScreeningDecision` — (stage, citation, reviewer) unique; `decision:
  INCLUDE|EXCLUDE|MAYBE|UNRESOLVED`; `exclusionReasonId` (**required at FULL_TEXT when
  EXCLUDE**, enforced in service+Zod); notes, labels (string[]), flaggedForDiscussion. Decisions
  are updated in place; every change writes an AuditEvent carrying the previous value, so full
  history is reconstructable.
- **Blinding**: with `blinded=true`, decision-read APIs filter out other reviewers' decisions
  until (a) the citation has all required decisions, or (b) an admin unblinds the stage. Enforced
  in the service layer (`visibleDecisionsFor()`), not the UI.
- `ScreeningConflict` — (stage, citation), status `OPEN|RESOLVED`. Generated transactionally when
  the required number of decisions exists and they disagree (MAYBE counts as conflicting when
  `maybeGeneratesConflict`, else it routes to adjudication as "needs judgment").
- `ScreeningAdjudication` — conflictId, adjudicatorId (from session, NOT NULL), finalDecision,
  exclusionReasonId?, reason (required). Recorded separately; reviewer decisions are untouched.

## Full text

- `FullTextFile` — storageKey, filename, contentType, sizeBytes, sha256, uploadedBy. Stored via
  the `FileStorage` interface.
- `CitationFullTextLink` — citation ↔ file, label (e.g., "main paper", "supplement").
- `FullTextRetrievalAttempt` — citation, method (publisher, ILL, author email…), outcome
  `RETRIEVED|NOT_RETRIEVED|PENDING`, notes, date. PRISMA "reports not retrieved" = citations
  advanced to full text whose latest outcome is not RETRIEVED and have no linked file.

## Extraction

- `ExtractionTemplate` — project-scoped, name, status `DRAFT|PUBLISHED|ARCHIVED`, version int.
  Publishing freezes structure; structural edits after use create a new version (same
  amendment philosophy as protocols).
- `ExtractionField` — template FK, key (machine name, unique per template), label, type
  (`TEXT|TEXTAREA|NUMBER|DATE|SINGLE_SELECT|MULTI_SELECT|BOOLEAN`), options JSON, required,
  section, order, helpText.
- `ExtractionAssignment` — (template, study, extractor, status) for dual extraction.
- `ExtractionForm` — (template, study, extractor) unique; citationId? for report-specific
  values; status `IN_PROGRESS|COMPLETED`.
- `ExtractionValue` — form FK + field FK; `value` JSON (typed by field.type, validated in
  service); `sourceQuote?`, `pageNumber?`, `notes?`, and `sourceAnchor?` JSON reserved for
  AI PDF anchoring (fileId + page + bbox/paragraph path). Unique (formId, fieldId).
- `ExtractionConflict` — (study, templateId, fieldId) when completed forms disagree on
  normalized value; `ExtractionAdjudication` stores the final value + adjudicator + reason.

## Risk of bias

- `RiskOfBiasTool` — `isBuiltin` (seeded generic tool; RoB2/ROBINS-I/QUADAS-2 seedable later) or
  project-scoped custom. Name, description, judgment scale (JSON list of allowed judgments).
- `RiskOfBiasDomain` — tool FK, name, order, guidance.
- `RiskOfBiasSignalingQuestion` — domain FK, text, order, allowed answers (Y/PY/PN/N/NI default).
- `RiskOfBiasAssessment` — (tool, study, assessor) unique; status; overallJudgment?.
- `RiskOfBiasJudgment` — assessment FK + domain FK unique; judgment
  (`LOW|SOME_CONCERNS|HIGH|UNCLEAR|NOT_APPLICABLE`), support (free text, "support for
  judgment"), notes.
- `RiskOfBiasSignalingResponse` — assessment + question unique; answer, note.
- `RiskOfBiasConflict` (study, domain) + `RiskOfBiasAdjudication` — same pattern as screening.

## PRISMA

- Counts are **always computed live** by `prisma-report.service` from base tables (single source
  of truth; no drift).
- `PrismaSnapshot` — frozen, named, timestamped copy for reporting: snapshot JSON +
  `PrismaCount(key, label, value, breakdown JSON)` rows (breakdown carries per-source and
  per-reason detail, e.g. records by database, full-text exclusions by reason —
  the spec's `FullTextExclusionSummary`).
- Count keys follow PRISMA 2020: recordsIdentified (by source), duplicatesRemoved,
  recordsScreened, recordsExcludedTitleAbstract, reportsSought, reportsNotRetrieved,
  reportsAssessed, reportsExcluded (by reason), studiesIncluded, reportsIncluded,
  studiesInQuantitativeSynthesis.

## Audit

`AuditEvent(id, projectId?, userId, entityType, entityId, action, previousValue Json?,
newValue Json?, reason?, metadata Json?, createdAt)` — see `06-audit-design.md`. Indexed on
(projectId, createdAt DESC) and (entityType, entityId).

## Exports

`ExportJob` — project, requestedBy, kind (CITATIONS|SCREENING|EXTRACTION|ROB|PRISMA|AUDIT|FULL),
format (CSV|JSON), status, storageKey. Export generation itself is audited.

## Deliberate deviations from the spec's entity list

| Spec entity | Implemented as | Why |
|---|---|---|
| InclusionCriterion / ExclusionCriterion | `EligibilityCriterion.type` | Identical shape; one table, one API. |
| ExtractionFieldDefinition (protocol) | `ExtractionField` + `Protocol.extractionTemplateId` | One field system for protocol planning and live extraction; no dual maintenance. |
| RiskOfBiasToolConfig (protocol) | `Protocol.riskOfBiasToolId` | Same reason. |
| Role (table) | `ProjectRole[]` enum + code capability matrix | Roles are static in MVP; a table adds joins without flexibility we use. Revisit for custom roles. |
| FullTextExclusionSummary | `PrismaCount.breakdown` + live query | Derived data; storing it independently invites drift. |
