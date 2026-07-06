// Audit action catalog — the only allowed values for AuditEvent.action.
// The audit UI filter dropdown derives from this list. See docs/06-audit-design.md.

export const AuditActions = {
  // org / project / membership
  ORG_CREATED: "org.created",
  ORG_UPDATED: "org.updated",
  PROJECT_CREATED: "project.created",
  PROJECT_UPDATED: "project.updated",
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
  IMPORT_BATCH_FAILED: "import.batch.failed",

  // dedup
  DEDUP_RUN: "dedup.run",
  DEDUP_MERGED: "dedup.merged",
  DEDUP_REJECTED: "dedup.rejected",
  DEDUP_MERGE_UNDONE: "dedup.merge_undone",

  // screening
  SCREENING_ASSIGNED: "screening.assigned",
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

  // studies
  STUDY_CREATED: "study.created",
  STUDY_UPDATED: "study.updated",
  STUDY_REPORT_LINKED: "study.report_linked",
  STUDY_REPORT_UNLINKED: "study.report_unlinked",

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

  // prisma / exports
  PRISMA_SNAPSHOT_CREATED: "prisma.snapshot.created",
  EXPORT_CREATED: "export.created",
} as const;

export type AuditAction = (typeof AuditActions)[keyof typeof AuditActions];

export const ALL_AUDIT_ACTIONS: AuditAction[] = Object.values(AuditActions);
