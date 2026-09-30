// Shared guarded reconciliation for companion reports. Caller holds the project lock.
import type { Tx } from "@/server/db";
import type { Ctx } from "@/server/auth/session";
import { invalidState } from "@/server/errors";
import * as audit from "@/server/services/audit";
import { AuditActions } from "@/server/services/audit";

export async function mergeStudies(
  tx: Tx,
  ctx: Ctx,
  projectId: string,
  sourceStudyId: string,
  studyId: string,
) {
  const source = await tx.study.findFirstOrThrow({
    where: { id: sourceStudyId, projectId },
    include: {
      _count: {
        select: {
          extractionForms: true,
          extractionAssignments: true,
          extractionConflicts: true,
          robAssignments: true,
          robAssessments: true,
          robConflicts: true,
          aiExtractionRuns: true,
          aiSuggestions: true,
          aiRobRuns: true,
          robSuggestions: true,
          analysisExclusions: true,
        },
      },
    },
  });
  // Every restricting Study relation must be covered here — a miss doesn't relax
  // the rule, it just turns the intended 422 into a P2003 crash at study.delete.
  const counts = source._count;
  const blocked =
    source.inQuantitativeSynthesis ||
    source.notes !== null ||
    counts.extractionForms > 0 ||
    counts.extractionAssignments > 0 ||
    counts.extractionConflicts > 0 ||
    counts.robAssignments > 0 ||
    counts.robAssessments > 0 ||
    counts.robConflicts > 0 ||
    counts.aiExtractionRuns > 0 ||
    counts.aiSuggestions > 0 ||
    counts.aiRobRuns > 0 ||
    counts.robSuggestions > 0 ||
    counts.analysisExclusions > 0;
  if (blocked) {
    throw invalidState(
      `Both reports already belong to different studies and “${source.label}” has ` +
        "extraction, risk-of-bias, AI, or analysis work. Merging would orphan that " +
        "work — reconcile the two studies manually instead.",
    );
  }
  // Move every report link off the source study (skip citations the target already has).
  const sourceLinks = await tx.studyReportLink.findMany({
    where: { studyId: sourceStudyId },
  });
  const targetLinks = await tx.studyReportLink.findMany({ where: { studyId } });
  const targetCitationIds = new Set(targetLinks.map((l) => l.citationId));
  for (const link of sourceLinks) {
    if (targetCitationIds.has(link.citationId)) {
      await tx.studyReportLink.delete({ where: { id: link.id } });
      await audit.record(tx, {
        projectId,
        userId: ctx.userId,
        entityType: "StudyReportLink",
        entityId: link.id,
        action: AuditActions.STUDY_REPORT_UNLINKED,
        previousValue: {
          studyId: sourceStudyId,
          citationId: link.citationId,
          isPrimaryReport: link.isPrimaryReport,
        },
        metadata: { mergedIntoStudyId: studyId },
      });
    } else {
      // Merged-in reports are never the primary of the surviving study.
      await tx.studyReportLink.update({
        where: { id: link.id },
        data: { studyId, isPrimaryReport: false },
      });
      await audit.record(tx, {
        projectId,
        userId: ctx.userId,
        entityType: "StudyReportLink",
        entityId: link.id,
        action: AuditActions.STUDY_REPORT_LINKED,
        previousValue: {
          studyId: sourceStudyId,
          citationId: link.citationId,
          isPrimaryReport: link.isPrimaryReport,
        },
        newValue: {
          studyId,
          citationId: link.citationId,
          isPrimaryReport: false,
        },
      });
    }
  }
  await tx.study.delete({ where: { id: sourceStudyId } });
  await audit.record(tx, {
    projectId,
    userId: ctx.userId,
    entityType: "Study",
    entityId: sourceStudyId,
    action: AuditActions.STUDY_MERGED,
    previousValue: { label: source.label },
    metadata: {
      from: sourceStudyId,
      to: studyId,
      movedReports: sourceLinks.length,
    },
  });
}
