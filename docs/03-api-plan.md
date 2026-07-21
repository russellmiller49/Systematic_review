# API Route Plan

All routes are Next.js Route Handlers under `src/app/api/`. Conventions:

- **Auth**: every route except `/api/auth/*` and `POST /api/users` (sign-up) requires a session.
  `getSessionUser()` throws 401.
- **Authorization**: route handlers never check roles themselves; services call
  `requirePermission(ctx, projectId, capability)` (403 on failure). Membership implies read
  access only per matrix.
- **Validation**: request bodies parsed with Zod; 400 with field errors on failure.
- **Errors**: JSON envelope `{ error: { code, message, details? } }`; `AppError` subclasses map
  to status codes (401 `UNAUTHENTICATED`, 403 `FORBIDDEN`, 404 `NOT_FOUND`, 409 `CONFLICT`,
  422 `INVALID_STATE`, 400 `VALIDATION`).
- **Success**: `{ data: ... }`. List endpoints support `?cursor=&limit=` where relevant.

## Auth & users

| Method | Path | Purpose |
|---|---|---|
| * | `/api/auth/[...nextauth]` | Auth.js (sign-in, session, sign-out) |
| POST | `/api/users` | Sign-up (email, name, password) |
| GET | `/api/me` | Current user + org/project memberships |

## Organizations

| POST | `/api/orgs` | Create org (creator becomes OWNER) |
| GET | `/api/orgs` | My orgs |
| GET/PATCH | `/api/orgs/[orgId]` | Read/update org |
| GET/POST | `/api/orgs/[orgId]/members` | List / add member by email |
| PATCH/DELETE | `/api/orgs/[orgId]/members/[userId]` | Change role / remove |
| GET/POST | `/api/orgs/[orgId]/invitations` | List / create organization invitation |
| DELETE | `/api/orgs/[orgId]/invitations/[invitationId]` | Revoke organization invitation |
| POST | `/api/organization-invitations/[token]/accept` | Accept organization invitation |

## Projects & membership

| POST | `/api/orgs/[orgId]/projects` | Create project (+ default stages, exclusion reasons) |
| GET | `/api/orgs/[orgId]/projects` | List projects in org |
| GET/PATCH | `/api/projects/[projectId]` | Read/update project settings |
| GET | `/api/projects/[projectId]/dashboard` | Aggregated dashboard stats |
| GET/POST | `/api/projects/[projectId]/members` | List / add member (existing user) |
| PATCH/DELETE | `/api/projects/[projectId]/members/[userId]` | Update roles / soft-remove |
| GET/POST | `/api/projects/[projectId]/invitations` | List / create invitation |
| DELETE | `/api/projects/[projectId]/invitations/[invitationId]` | Revoke project invitation |
| POST | `/api/invitations/[token]/accept` | Accept invitation |

## Protocol

| GET | `/api/projects/[projectId]/protocol` | Full protocol + children |
| PATCH | `/api/projects/[projectId]/protocol` | Update fields (requires `amendmentReason` once screening began) |
| POST | `/api/projects/[projectId]/protocol/publish` | Freeze a ProtocolVersion |
| GET | `/api/projects/[projectId]/protocol/versions` | Version list + snapshots |
| GET | `/api/projects/[projectId]/protocol/amendments` | Amendment log |
| POST/PATCH/DELETE | `.../protocol/criteria[/id]` | Eligibility criteria CRUD |
| POST/PATCH/DELETE | `.../protocol/outcomes[/id]` | Outcome definitions CRUD |
| POST/PATCH/DELETE | `.../protocol/pico[/id]` | PICO questions CRUD |
| GET/POST/PATCH/DELETE | `/api/projects/[projectId]/exclusion-reasons[/id]` | Exclusion reason list CRUD |

## Import

| GET/POST | `/api/projects/[projectId]/import-sources` | Named sources CRUD |
| POST | `/api/projects/[projectId]/imports` | Upload file (multipart) + parse → PREVIEWED batch with parsed rows + per-row errors |
| GET | `/api/projects/[projectId]/imports` | Batch list |
| GET | `/api/projects/[projectId]/imports/[batchId]` | Batch detail + preview rows |
| POST | `/api/projects/[projectId]/imports/[batchId]/commit` | Create citations (+ auto exact-dedup pass) |

## Citations & dedup

| GET | `/api/projects/[projectId]/citations` | Filterable list (status, stage progress, search) |
| GET | `/api/projects/[projectId]/citations/[citationId]` | Detail (+source records, identifiers) |
| POST | `/api/projects/[projectId]/dedup/run` | Run/re-run detection (exact + fuzzy) |
| GET | `/api/projects/[projectId]/dedup/groups` | Candidate groups with evidence |
| POST | `/api/projects/[projectId]/dedup/groups/[groupId]/merge` | Merge (body: canonicalCitationId) |
| POST | `/api/projects/[projectId]/dedup/candidates/[candidateId]/reject` | Reject suggestion |
| POST | `/api/projects/[projectId]/dedup/merges/[citationId]/undo` | Undo a merge |

## Screening

| GET | `/api/projects/[projectId]/screening/stages` | Stage configs + progress |
| PATCH | `/api/projects/[projectId]/screening/stages/[stageId]` | Update config (blinding, reviewersPerCitation) / unblind |
| POST | `/api/projects/[projectId]/screening/stages/[stageId]/assignments` | Bulk-assign reviewers (strategy: all, split) |
| GET | `/api/projects/[projectId]/screening/stages/[stageId]/queue` | My next citations (blind-safe) |
| POST | `/api/projects/[projectId]/screening/stages/[stageId]/decisions` | Create/update my decision |
| GET | `/api/projects/[projectId]/screening/stages/[stageId]/decisions?citationId=` | Decisions (blind-filtered) |
| GET | `/api/projects/[projectId]/conflicts?stage=` | Open/resolved conflicts + all decisions/notes (adjudicator view) |
| POST | `/api/projects/[projectId]/conflicts/[conflictId]/adjudicate` | Final decision + required reason |

## Full text

| POST | `/api/projects/[projectId]/fulltext/files` | Upload PDF (multipart) → FullTextFile + link to citation |
| GET | `/api/files/[fileId]` | Stream file (permission-checked) |
| POST | `/api/projects/[projectId]/citations/[citationId]/retrieval-attempts` | Record attempt/outcome |
| GET | `/api/projects/[projectId]/fulltext/queue` | FT screening queue (retrieval status + files) |

(FT screening decisions reuse the screening decision endpoints with the FULL_TEXT stage.)

## Extraction

| GET/POST | `/api/projects/[projectId]/extraction/templates` | List / create |
| GET/PATCH | `.../templates/[templateId]` | Read / update meta; `POST .../publish` |
| POST/PATCH/DELETE | `.../templates/[templateId]/fields[/fieldId]` | Field builder CRUD |
| GET | `/api/projects/[projectId]/studies` | Included studies (+ linked reports) |
| POST | `/api/projects/[projectId]/studies/[studyId]/extraction-forms` | Start form (template, extractor=self) |
| GET | `.../extraction-forms?studyId=&templateId=` | Forms (own, or all if adjudicator/admin) |
| PUT | `.../extraction-forms/[formId]/values/[fieldId]` | Upsert value (+quote/page/notes) |
| POST | `.../extraction-forms/[formId]/complete` | Mark complete → conflict detection |
| GET | `/api/projects/[projectId]/extraction/conflicts` | Field-level conflicts |
| POST | `.../extraction/conflicts/[conflictId]/adjudicate` | Final value + reason |

## Risk of bias

| GET | `/api/rob/tools` | Built-in tools |
| GET/POST | `/api/projects/[projectId]/rob/tools` | Project tools list/create (custom) |
| POST/PATCH/DELETE | `.../rob/tools/[toolId]/domains[/domainId]` | Domain/question builder |
| POST | `/api/projects/[projectId]/studies/[studyId]/rob/assessments` | Start assessment (assessor=self) |
| GET | `.../rob/assessments?studyId=` | Assessments (blind-safe like screening) |
| PUT | `.../rob/assessments/[assessmentId]/judgments/[domainId]` | Upsert judgment + support |
| PUT | `.../rob/assessments/[assessmentId]/responses/[questionId]` | Signaling answer |
| POST | `.../rob/assessments/[assessmentId]/complete` | Complete → conflict detection |
| POST | `.../rob/conflicts/[conflictId]/adjudicate` | Resolve |

## PRISMA, audit, exports

| GET | `/api/projects/[projectId]/prisma` | Live PRISMA counts (+breakdowns) |
| POST | `/api/projects/[projectId]/prisma/snapshots` | Freeze snapshot |
| GET | `/api/projects/[projectId]/prisma/snapshots[/snapshotId]` | List / detail |
| GET | `/api/projects/[projectId]/audit?entityType=&entityId=&userId=&action=&cursor=` | Queryable audit log |
| POST | `/api/projects/[projectId]/exports` | Create export (kind, format) → runs inline, returns job with download key |
| GET | `/api/projects/[projectId]/exports[/jobId]` | List / status |
| GET | `/api/projects/[projectId]/exports/[jobId]/download` | Stream file |
