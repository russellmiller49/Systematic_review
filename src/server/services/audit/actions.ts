// Audit action catalog — the only allowed values for AuditEvent.action.
// The audit UI filter dropdown derives from this list. See docs/06-audit-design.md.

export const AuditActions = {
  // org / project / membership
  ORG_CREATED: "org.created",
  ORG_UPDATED: "org.updated",
  PROJECT_CREATED: "project.created",
  PROJECT_UPDATED: "project.updated",
  PROJECT_SUBPROJECT_CREATED: "project.subproject.created",
  MEMBER_ADDED: "member.added",
  MEMBER_ROLES_CHANGED: "member.roles_changed",
  MEMBER_REMOVED: "member.removed",
  INVITATION_CREATED: "invitation.created",
  INVITATION_ACCEPTED: "invitation.accepted",
  INVITATION_REVOKED: "invitation.revoked",
  USER_CREATED: "user.created",

  // protocol
  PROTOCOL_UPDATED: "protocol.updated",
  PROTOCOL_PUBLISHED: "protocol.published",
  PROTOCOL_AMENDED: "protocol.amended",
  CRITERION_CREATED: "protocol.criterion.created",
  CRITERION_UPDATED: "protocol.criterion.updated",
  CRITERION_DELETED: "protocol.criterion.deleted",
  OUTCOME_CREATED: "protocol.outcome.created",
  OUTCOME_UPDATED: "protocol.outcome.updated",
  OUTCOME_DELETED: "protocol.outcome.deleted",
  PICO_CREATED: "protocol.pico.created",
  PICO_UPDATED: "protocol.pico.updated",
  PICO_DELETED: "protocol.pico.deleted",
  EXCLUSION_REASON_CREATED: "exclusion_reason.created",
  EXCLUSION_REASON_UPDATED: "exclusion_reason.updated",
  EXCLUSION_REASON_DELETED: "exclusion_reason.deleted",

  // import
  IMPORT_BATCH_CREATED: "import.batch.created",
  IMPORT_BATCH_COMMITTED: "import.batch.committed",
  IMPORT_BATCH_DELETED: "import.batch.deleted",
  IMPORT_BATCH_FAILED: "import.batch.failed",

  // dedup
  DEDUP_RUN: "dedup.run",
  DEDUP_MERGED: "dedup.merged",
  DEDUP_REJECTED: "dedup.rejected",
  DEDUP_MERGE_UNDONE: "dedup.merge_undone",

  // screening
  SCREENING_ASSIGNED: "screening.assigned",
  SCREENING_ASSIGNMENTS_RESET: "screening.assignments.reset",
  SCREENING_DECISION_CREATED: "screening.decision.created",
  SCREENING_DECISION_UPDATED: "screening.decision.updated",
  SCREENING_CONFLICT_OPENED: "screening.conflict.opened",
  SCREENING_CONFLICT_REOPENED: "screening.conflict.reopened",
  SCREENING_CONFLICT_ADJUDICATED: "screening.conflict.adjudicated",
  SCREENING_RESULT_CREATED: "screening.result.created",
  SCREENING_RESULT_REOPENED: "screening.result.reopened",
  SCREENING_STAGE_UPDATED: "screening.stage.updated",
  SCREENING_STAGE_UNBLINDED: "screening.stage.unblinded",

  // full text
  FULLTEXT_FILE_UPLOADED: "fulltext.file.uploaded",
  FULLTEXT_FILE_LINKED: "fulltext.file.linked",
  FULLTEXT_RETRIEVAL_RECORDED: "fulltext.retrieval.recorded",
  FULLTEXT_TEXT_EXTRACTED: "fulltext.text.extracted",

  // institutional library / OA auto-fetch (run-level only — engine-created retrieval
  // attempt rows are machine output, unaudited per-row like AI suggestion rows; PDF
  // stores still audit via fulltext.file.uploaded because uploadFullText is reused)
  ORG_LIBRARY_SETTINGS_UPDATED: "org.library_settings.updated",
  FULLTEXT_AUTOFETCH_STARTED: "fulltext.autofetch.started",
  FULLTEXT_AUTOFETCH_COMPLETED: "fulltext.autofetch.completed",
  FULLTEXT_AUTOFETCH_FAILED: "fulltext.autofetch.failed",
  FULLTEXT_AUTOFETCH_CANCELED: "fulltext.autofetch.canceled",

  // studies
  STUDY_CREATED: "study.created",
  STUDY_UPDATED: "study.updated",
  STUDY_REPORT_LINKED: "study.report_linked",
  STUDY_REPORT_UNLINKED: "study.report_unlinked",
  STUDY_MERGED: "study.merged",

  // cohort-overlap detection
  COHORT_RUN: "cohort.run",
  COHORT_LINKED: "cohort.linked",
  COHORT_REJECTED: "cohort.rejected",

  // extraction
  EXTRACTION_TEMPLATE_CREATED: "extraction.template.created",
  EXTRACTION_TEMPLATE_UPDATED: "extraction.template.updated",
  EXTRACTION_TEMPLATE_PUBLISHED: "extraction.template.published",
  EXTRACTION_FIELD_CREATED: "extraction.field.created",
  EXTRACTION_FIELD_UPDATED: "extraction.field.updated",
  EXTRACTION_FIELD_DELETED: "extraction.field.deleted",
  EXTRACTION_ASSIGNED: "extraction.assigned",
  EXTRACTION_FORM_STARTED: "extraction.form.started",
  EXTRACTION_FORM_COMPLETED: "extraction.form.completed",
  EXTRACTION_VALUE_CREATED: "extraction.value.created",
  EXTRACTION_VALUE_UPDATED: "extraction.value.updated",
  EXTRACTION_VALUE_REANCHORED: "extraction.value.reanchored",
  EXTRACTION_REANCHOR_RUN: "extraction.reanchor.run",
  EXTRACTION_CONFLICT_OPENED: "extraction.conflict.opened",
  EXTRACTION_CONFLICT_ADJUDICATED: "extraction.conflict.adjudicated",

  // risk of bias
  ROB_TOOL_CREATED: "rob.tool.created",
  ROB_TOOL_UPDATED: "rob.tool.updated",
  ROB_TOOL_PUBLISHED: "rob.tool.published",
  ROB_ASSIGNED: "rob.assigned",
  ROB_ASSESSMENT_STARTED: "rob.assessment.started",
  ROB_ASSESSMENT_COMPLETED: "rob.assessment.completed",
  ROB_JUDGMENT_CREATED: "rob.judgment.created",
  ROB_JUDGMENT_UPDATED: "rob.judgment.updated",
  ROB_CONFLICT_OPENED: "rob.conflict.opened",
  ROB_CONFLICT_ADJUDICATED: "rob.conflict.adjudicated",

  // analysis (meta-analysis module; read/compute endpoints are unaudited — precedent:
  // live PRISMA counts)
  ANALYSIS_OUTCOME_CREATED: "analysis.outcome.created",
  ANALYSIS_OUTCOME_UPDATED: "analysis.outcome.updated",
  ANALYSIS_OUTCOME_DELETED: "analysis.outcome.deleted",
  ANALYSIS_MAPPINGS_REPLACED: "analysis.mappings.replaced",
  ANALYSIS_STUDY_EXCLUSION_SET: "analysis.study_exclusion.set",

  // grade (certainty of evidence; getGradeView/computeSof are unaudited reads — same
  // precedent as analysis results)
  GRADE_ASSESSMENT_GENERATED: "grade.assessment.generated",
  GRADE_ASSESSMENT_UPDATED: "grade.assessment.updated",
  GRADE_ASSESSMENT_REVIEWED: "grade.assessment.reviewed",
  GRADE_RATING_UPDATED: "grade.rating.updated",

  // team chat — STRUCTURAL events only. Deliberately unaudited: message post/edit and
  // read-state upserts (chat is high-frequency conversational data; messages are their
  // own durable attributed record — authorId/createdAt/editedAt/tombstones — and auditing
  // every post would duplicate the ChatMessage table into the append-only log). Deletes
  // audit a 200-char snippet so moderation stays accountable.
  CHAT_CHANNEL_CREATED: "chat.channel.created",
  CHAT_CHANNEL_ARCHIVED: "chat.channel.archived",
  CHAT_MESSAGE_DELETED: "chat.message.deleted",
  CHAT_ASSIGNMENT_CREATED: "chat.assignment.created",
  CHAT_ASSIGNMENT_COMPLETED: "chat.assignment.completed",
  CHAT_ASSIGNMENT_VOIDED: "chat.assignment.voided",

  // manuscript drafting. Deliberately unaudited: per-keystroke autosave content saves
  // (the durable version rows ARE the audited record — a 2s debounce would flood the
  // log) and lock acquire/heartbeat/release (transient coordination state). Takeover IS
  // audited because it overrides another user.
  MANUSCRIPT_CREATED: "manuscript.created",
  MANUSCRIPT_UPDATED: "manuscript.updated",
  MANUSCRIPT_SECTION_CREATED: "manuscript.section.created",
  MANUSCRIPT_SECTION_UPDATED: "manuscript.section.updated",
  MANUSCRIPT_SECTION_DELETED: "manuscript.section.deleted",
  MANUSCRIPT_SECTIONS_REORDERED: "manuscript.sections.reordered",
  MANUSCRIPT_SECTION_ASSIGNED: "manuscript.section.assigned",
  MANUSCRIPT_SECTION_STATUS_CHANGED: "manuscript.section.status_changed",
  MANUSCRIPT_VERSION_CREATED: "manuscript.section.version.created",
  MANUSCRIPT_VERSION_RESTORED: "manuscript.section.version.restored",
  MANUSCRIPT_LOCK_TAKEN_OVER: "manuscript.section.lock.taken_over",
  MANUSCRIPT_COMMENT_CREATED: "manuscript.comment.created",
  MANUSCRIPT_COMMENT_RESOLVED: "manuscript.comment.resolved",
  MANUSCRIPT_COMMENT_REOPENED: "manuscript.comment.reopened",
  MANUSCRIPT_COMMENT_DELETED: "manuscript.comment.deleted",
  MANUSCRIPT_EXPORTED: "manuscript.exported",

  // reference library (citation manager; bibliography formatting is an unaudited read —
  // precedent: live PRISMA counts)
  REFERENCE_CREATED: "reference.created",
  REFERENCE_UPDATED: "reference.updated",
  REFERENCE_DELETED: "reference.deleted",
  REFERENCES_IMPORTED: "reference.imported",
  REFERENCE_EXPORTED: "reference.exported",

  // prisma / exports
  PRISMA_SNAPSHOT_CREATED: "prisma.snapshot.created",
  EXPORT_CREATED: "export.created",

  // ai assistance (run-level only — individual suggestion rows are machine output and are
  // deliberately NOT audited; a 5k-citation run would flood the log)
  AI_PRESCREEN_STARTED: "ai.prescreen.started",
  AI_PRESCREEN_COMPLETED: "ai.prescreen.completed",
  AI_PRESCREEN_FAILED: "ai.prescreen.failed",
  AI_PRESCREEN_CANCELED: "ai.prescreen.canceled",
  AI_EXTRACTION_STARTED: "ai.extraction.started",
  AI_EXTRACTION_COMPLETED: "ai.extraction.completed",
  AI_EXTRACTION_FAILED: "ai.extraction.failed",
  AI_ROB_STARTED: "ai.rob.started",
  AI_ROB_COMPLETED: "ai.rob.completed",
  AI_ROB_FAILED: "ai.rob.failed",
  AI_GRADE_STARTED: "ai.grade.started",
  AI_GRADE_COMPLETED: "ai.grade.completed",
  AI_GRADE_FAILED: "ai.grade.failed",
} as const;

export type AuditAction = (typeof AuditActions)[keyof typeof AuditActions];

export const ALL_AUDIT_ACTIONS: AuditAction[] = Object.values(AuditActions);
