# Audit Trail Design

## Requirements recap

Every important action creates an `AuditEvent` recording who, what, when, previous/new values,
and why. The trail is queryable from the project dashboard and exportable.

## Schema

```prisma
model AuditEvent {
  id            String   @id @default(cuid())
  projectId     String?          // null only for org/user-level events
  userId        String           // actor; FK to User (never deleted, users are never hard-deleted)
  entityType    String           // "Citation" | "ScreeningDecision" | ... (PascalCase model name)
  entityId      String
  action        String           // dot-namespaced verb, e.g. "screening.decision.updated"
  previousValue Json?            // relevant field subset BEFORE (null on create)
  newValue      Json?            // relevant field subset AFTER  (null on delete)
  reason        String?          // human-entered rationale (required for amendments/adjudications)
  metadata      Json?            // correlation: batchId, stageId, conflictId, ip, etc.
  createdAt     DateTime @default(now())

  @@index([projectId, createdAt(sort: Desc)])
  @@index([entityType, entityId])
  @@index([projectId, userId])
  @@index([projectId, action])
}
```

Append-only: no update/delete API or service path exists for audit rows.

## Write mechanics — the one rule

**Audit events are written inside the same database transaction as the mutation they record**,
via `audit.record(tx, event)` where `tx` is the transaction client. A mutation that commits
without its audit event is a bug class we eliminate structurally: services expose
`withAudit`-style helpers and code review enforces that every service mutation passes `tx` down.
No fire-and-forget logging, no middleware guessing.

`previousValue`/`newValue` contain the **meaningful field subset**, not entire rows (e.g. a
screening decision change records `{decision, exclusionReasonId, notes}` before/after), keeping
the log human-readable and diffable in the UI.

## Action catalog (MVP)

| Area | Actions |
|---|---|
| Org/project | `org.created`, `project.created`, `project.updated`, `member.added`, `member.roles_changed`, `member.removed`, `invitation.created`, `invitation.accepted` |
| Protocol | `protocol.updated`, `protocol.published`, `protocol.amended`, `protocol.criterion.{created,updated,deleted}`, `protocol.outcome.{created,updated,deleted}`, `protocol.pico.{created,updated,deleted}`, `exclusion_reason.{created,updated,deleted}` |
| Import | `import.batch.created`, `import.batch.committed`, `import.batch.failed` |
| Dedup | `dedup.run`, `dedup.merged`, `dedup.rejected`, `dedup.merge_undone` |
| Screening | `screening.assigned`, `screening.decision.created`, `screening.decision.updated`, `screening.conflict.opened`, `screening.conflict.adjudicated`, `screening.stage.updated`, `screening.stage.unblinded` |
| Full text | `fulltext.file.uploaded`, `fulltext.file.linked`, `fulltext.retrieval.recorded` |
| Extraction | `extraction.template.{created,updated,published}`, `extraction.field.{created,updated,deleted}`, `extraction.form.{started,completed}`, `extraction.value.{created,updated}`, `extraction.conflict.{opened,adjudicated}` |
| RoB | `rob.tool.{created,updated}`, `rob.assessment.{started,completed}`, `rob.judgment.{created,updated}`, `rob.conflict.{opened,adjudicated}` |
| PRISMA/exports | `prisma.snapshot.created`, `export.created` |
| Library/OA fetch | `org.library_settings.updated`, `fulltext.autofetch.{started,completed,failed,canceled}` (run-level; engine-created retrieval-attempt rows are unaudited machine output — AI-suggestion precedent) |
| References | `reference.{created,updated,deleted,imported,exported}` (bibliography formatting is an unaudited read) |
| Manuscript | `manuscript.{created,updated,exported}`, `manuscript.section.{created,updated,deleted,assigned,status_changed}`, `manuscript.sections.reordered`, `manuscript.section.version.{created,restored}`, `manuscript.section.lock.taken_over`, `manuscript.comment.{created,resolved,reopened,deleted}` |
| Team chat | `chat.channel.{created,archived}`, `chat.message.deleted`, `chat.assignment.{created,completed,voided}` |

Action strings are constants in `src/server/services/audit/actions.ts` (typo-proof, greppable,
and the audit UI derives its filter dropdown from the same constant list).

### Deliberate high-frequency exemptions (2026-07-21)

Two collaboration features deviate from "every mutation audits", by design:

- **Manuscript autosaves + lock coordination** are unaudited — a 2s-debounced autosave would
  flood the append-only log, and the durable `ManuscriptSectionVersion` rows cut at every
  session boundary ARE the audited record (`manuscript.section.version.created`). Lock
  TAKEOVER is audited because it overrides another user.
- **Chat message post/edit and read-state upserts** are unaudited — messages are their own
  durable attributed record (author, timestamps, edit marks, soft-delete tombstones), and
  auditing every post would duplicate the `ChatMessage` table into `AuditEvent`. Structural
  events (channels, assignment lifecycle, deletes with a 200-char snippet) are audited, and
  `tests/integration/chat.test.ts` pins the policy by asserting no other `chat.*` actions
  appear. DM-channel creation audits reveal the participant list to `audit.view` holders
  (accepted: governance-first tool); DM *content* never enters the log.

## Query & UI

- `GET /api/projects/[id]/audit` filters by entityType+entityId, userId, action prefix, date
  range; cursor-paginated, newest first.
- Audit page renders actor, action, entity link, relative time, and a before/after `DiffViewer`.
- Entity detail views (citation, decision, protocol) can show their own history via the
  `(entityType, entityId)` index.
- Full audit export = JSON/CSV dump through the standard export service (which itself audits
  `export.created` — exports of the audit log are visible in the audit log).

## Future-proofing

- ~~The event stream is the natural source for notifications (domain 16)~~ — superseded
  2026-07-21: notifications are emitted DIRECTLY by services inside the same transaction as
  the mutation (`src/server/services/notifications`), which gives the same atomicity with no
  recipient-resolution machinery, and works for chat messages (which are deliberately not
  audited). Audit remains the compliance record; notifications are the delivery substrate.
  Living-review triage feeds can still tail `AuditEvent.id`.
- If volume demands it, partition by `projectId`/month — the API surface is unchanged.
