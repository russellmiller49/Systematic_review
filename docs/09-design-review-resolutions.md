# Design Review Resolutions

An adversarial multi-agent review of docs/01–08 + the schema draft produced 32 confirmed
findings (deduplicating to ~18 issues). This document records the decided policy for each.
**Where this doc conflicts with docs/02–06, this doc wins** — it is the implementation contract.

## Critical

### R1. Audit log & exports must not leak blinded content
`AuditEvent` rows for **sensitive entity types** — `ScreeningDecision`, `ScreeningConflict`,
`ScreeningAdjudication`, `ExtractionValue`, `ExtractionForm`, `ExtractionConflict`,
`RiskOfBiasAssessment`, `RiskOfBiasJudgment`, `RiskOfBiasSignalingResponse`,
`RiskOfBiasConflict` — are visible in audit queries **only** to: (a) the event's actor,
(b) holders of `project.edit` (OWNER/ADMIN), (c) holders of the domain's adjudicate capability
(`screening.adjudicate` for screening entities, etc.). Everyone else sees these rows excluded
entirely. This is a static rule (no per-citation blinding join) — simple, safe, testable.
Final-tier GRADE entities (`GradeAssessment`, `GradeDomainRating`, `AiGradeRun`) follow a
separate analysis boundary: their pooled-result/PICO prose and actor attribution are visible
only with current `analysis.view` or `project.edit`; the historical actor exception does not
apply after that capability is removed.
**Exports**: kinds `SCREENING`, `EXTRACTION`, `ROB`, `AUDIT`, `FULL` additionally require
`project.edit`; `ANALYSIS` and `GRADE` require `export.create` plus `analysis.view`;
`CITATIONS` and `PRISMA` require only `export.create`. Integration tests assert these boundaries.

### R2. RoB judgments are Strings validated per tool
`RiskOfBiasJudgment.judgment`, `RiskOfBiasAssessment.overallJudgment`,
`RiskOfBiasAdjudication.finalJudgment` are `String`, validated in the service against
`RiskOfBiasTool.judgmentScale` (JSON: `[{value, label, color, severity}]`). The built-in generic
tool seeds the classic scale (low / some_concerns / high / unclear / not_applicable). Same
pattern as signaling answers vs `allowedAnswers`.

### R3. Stage progression is materialized: `CitationStageResult`
Written in the **same transaction** as the event that settles a citation at a stage:
- consensus: last required decision arrives and all required decisions agree
  (INCLUDE or EXCLUDE unanimously) → `resolvedVia=CONSENSUS` (`SINGLE_REVIEWER` when
  reviewersPerCitation=1);
- adjudication: `resolvedVia=ADJUDICATION` with the adjudicated outcome.
Only INCLUDE/EXCLUDE materialize. "Eligible for FULL_TEXT" ≡ INCLUDE result at TITLE_ABSTRACT.
Full-text assignments can only target eligible citations. PRISMA derives from stage results +
decisions. Reopening (below) deletes the result row (audited with previous value).

### R4. Quantitative synthesis membership
`Study.inQuantitativeSynthesis Boolean @default(false)` + `PATCH /studies/[id]` + audit
`study.updated`. Qualitative synthesis count = all studies.

## Screening lifecycle (locks, conflicts, MAYBE)

### R5. Decision mutability
Reviewers may create/update **their own** decision **while the citation has no
`CitationStageResult` for that stage** and they hold a non-VOIDED assignment. Once a result
exists, decision writes are rejected (422) — changes require an admin/adjudicator **reopen**
(`POST .../citations/[id]/reopen`, reason required, audited): deletes the stage result, voids
any resolved conflict (status=VOIDED), after which decisions can change and conflict detection
re-runs. Every decision update writes audit with previousValue. The same lock applies after
adjudication (the result row exists). Extraction values and RoB judgments mirror this: locked
once their conflict is adjudicated, unless reopened.

### R6. Conflict lifecycle
Conflict evaluation runs transactionally on **every decision write** for the affected citation:
- required number of decisions present + disagreement → open conflict (or leave open);
- agreement after an edit (pre-lock) → auto-resolve: conflict status=VOIDED, consensus result written.
`ScreeningAdjudication` stays 1:1 with its conflict; re-adjudication after reopen updates the
row in place (audit carries previous value) and re-writes the stage result.

### R7. MAYBE / UNRESOLVED semantics
- Reviewers submit INCLUDE / EXCLUDE / MAYBE only.
- `maybeGeneratesConflict` controls whether MAYBE-vs-decisive splits open a conflict.
  **Unanimous MAYBE always opens a conflict** (someone must decide) regardless of the flag.
- Adjudication `finalDecision` is restricted to INCLUDE | EXCLUDE (Zod).
- `UNRESOLVED` remains in the enum solely as a display state for computed statuses (a citation
  not yet settled); it is never stored in `ScreeningDecision.decision` and never materializes
  in stage results.

### R8. Duplicate merge after screening began
Merging a duplicate: PENDING assignments on the duplicate → VOIDED; its decisions are kept
immutable for the record; OPEN conflicts → VOIDED; stage results on the duplicate are kept but
ignored (all queue/conflict/PRISMA queries filter `citation.status=ACTIVE`). If **both**
citations already carry decisions, the merge response includes a warning payload; the canonical
citation's screening history is authoritative. Undo restores VOIDED assignments/conflicts to
their prior status (recorded in the audit metadata of the merge event).

## Security / integrity

### R9. Tenancy convention (IDOR)
Every by-id entity load is scoped: `findFirst({ where: { id, <projectId-derivable filter> } })`
→ 404 on mismatch. Every FK accepted in a request body (exclusionReasonId, templateId, toolId,
citationId, studyId, fileId, …) is validated to belong to the path project. The one allowed
exception: built-in RoB tools (`projectId=null`) are readable everywhere but **never mutable**
via project routes — using a built-in tool clones it into the project (`isBuiltin=false`,
lineage in audit metadata). Tool structure freezes once any assessment exists (structural edits
then require a clone, like extraction templates).

### R10. Org membership gates project access
`requirePermission` requires BOTH an ACTIVE `ProjectMember` row AND an ACTIVE
`OrganizationMember` row in the project's org. Removing someone from the org instantly cuts
project access while preserving their attributed work. Test: org-REMOVED user with
project-ACTIVE row → 403.

### R11. Invitations
Project and organization invitation tokens use `crypto.randomBytes(32)` base64url and are
returned only in the create response, never in lists. Accept requires: session user's email ===
invitation.email (lowercased), not expired, not accepted, not revoked — checked and consumed
atomically. Project invitations grant the assigned project roles and ensure an ACTIVE org
membership; organization invitations grant the selected `OrgRole`. An active organization or
project invitation also permits that email through the pilot signup gate. Tenant-scoped DELETE
routes revoke invitations (`revokedAt`, audited `invitation.revoked`).

### R12. Auth hardening (MVP stance)
Password ≥ 10 chars, bcrypt cost 12. `User.passwordChangedAt` invalidates older JWTs via the
jwt callback. No password reset flow in MVP (documented limitation; admin can reset via script).
Rate limiting deferred to deployment layer (documented).

### R13. File upload/serving
Uploads: PDF only — server sniffs `%PDF-` magic bytes, rejects otherwise; contentType stored as
`application/pdf` (server-determined, never client's); 50 MB cap. Serving: permission check =
membership in the file's project (`project.view`), headers `X-Content-Type-Options: nosniff`,
`Content-Disposition: inline; filename="<sanitized>"`.

## Workflow completeness

### R14. Studies API
`POST /projects/[id]/studies` (from an FT-included citation or manual),
`PATCH /studies/[studyId]` (label, notes, inQuantitativeSynthesis),
`POST /studies/[studyId]/reports` (link citation, optional isPrimaryReport),
`DELETE /studies/[studyId]/reports/[citationId]` (unlink). Default flow: creating the FT
INCLUDE stage result **auto-creates a Study** (label from first author + year) linked to the
citation; the studies UI offers "merge into existing study" (relink reports, audited). MVP soft
rule: one study per citation (service-enforced).

### R15. Extraction & RoB assignments
`POST /projects/[id]/extraction/assignments` and `POST /projects/[id]/rob/assignments`
(bulk: studies × extractors/assessors), `GET` my-assignments. Starting a form/assessment
requires an assignment (admins can self-assign implicitly). Conflict detection triggers when
**≥ 2 COMPLETED** forms/assessments exist for the (study, template/tool): field-by-field
(extraction) or domain-by-domain + overall (RoB) comparison; conflicts open/refresh on each
completion. Audit: `extraction.assigned`, `rob.assigned`.

### R16. Extraction template versioning
PUBLISHED templates are structurally immutable (label/description edits allowed; fields
frozen). "Edit a published template" = clone into a new DRAFT row (`sourceTemplateId`,
`version+1`); publishing the clone archives the source. Forms permanently reference the exact
template version they were extracted with.

### R17. DedupCandidate relations
Real FK relations `citationA`/`citationB` with back-relations + index on `citationBId`
(pair-unique already covers A). Merge service verifies the canonical citation is in the group
and belongs to the project.

### R18. StudyReportLink cardinality
DB allows a report to link to multiple studies (future cohort-overlap); the MVP service
enforces one study per report. `@@unique([studyId, citationId])` + index on citationId.
