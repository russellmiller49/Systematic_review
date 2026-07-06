// Studies service — the analysis unit (R14, R18 in docs/09).
// A Study is auto-created when a citation reaches an FT INCLUDE stage result (screening
// service calls autoCreateForCitation inside ITS transaction), or manually via POST /studies.

import { z } from "zod";
import type { Citation } from "@prisma/client";
import { prisma, type Tx } from "@/server/db";
import { conflict, invalidState, notFound } from "@/server/errors";
import type { Ctx } from "@/server/auth/session";
import { requirePermission } from "@/server/permissions";
import * as audit from "@/server/services/audit";
import { AuditActions } from "@/server/services/audit";

export const createStudySchema = z.object({
  label: z.string().trim().min(1).max(200),
  citationId: z.string().min(1).optional(),
});

export const updateStudySchema = z.object({
  label: z.string().trim().min(1).max(200).optional(),
  notes: z.string().max(20_000).nullable().optional(),
  inQuantitativeSynthesis: z.boolean().optional(),
});

export const linkReportSchema = z.object({
  citationId: z.string().min(1),
  isPrimaryReport: z.boolean().optional(),
});

// "Smith 2019" from the first author's family name + year; fallback: title prefix.
export function studyLabelFor(citation: Pick<Citation, "title" | "authors" | "year">): string {
  const authors = citation.authors;
  let family: string | null = null;
  if (Array.isArray(authors) && authors.length > 0) {
    const first = authors[0];
    if (first && typeof first === "object" && !Array.isArray(first)) {
      const fam = (first as Record<string, unknown>).family;
      if (typeof fam === "string" && fam.trim().length > 0) family = fam.trim();
    }
  }
  if (family) return citation.year ? `${family} ${citation.year}` : family;
  return citation.title.slice(0, 40).trim();
}

// Called by the screening service inside the SAME transaction that writes an FT INCLUDE
// stage result (R14). No permission check here: the trigger is the screening lifecycle
// itself, and the actor may be a plain reviewer whose consensus decision settled the citation.
// R18 soft rule: one study per report — if the citation already links to a study, skip.
export async function autoCreateForCitation(
  tx: Tx,
  ctx: Ctx,
  projectId: string,
  citationId: string,
) {
  const existingLink = await tx.studyReportLink.findFirst({ where: { citationId } });
  if (existingLink) return null;
  const citation = await tx.citation.findFirst({ where: { id: citationId, projectId } });
  if (!citation) throw notFound("Citation");
  const study = await tx.study.create({
    data: { projectId, label: studyLabelFor(citation), createdById: ctx.userId },
  });
  const link = await tx.studyReportLink.create({
    data: { studyId: study.id, citationId, isPrimaryReport: true },
  });
  await audit.record(tx, {
    projectId,
    userId: ctx.userId,
    entityType: "Study",
    entityId: study.id,
    action: AuditActions.STUDY_CREATED,
    newValue: { label: study.label, citationId, autoCreated: true },
  });
  await audit.record(tx, {
    projectId,
    userId: ctx.userId,
    entityType: "StudyReportLink",
    entityId: link.id,
    action: AuditActions.STUDY_REPORT_LINKED,
    newValue: { studyId: study.id, citationId, isPrimaryReport: true },
  });
  return study;
}

export async function listStudies(ctx: Ctx, projectId: string) {
  await requirePermission(ctx, projectId, "project.view");
  return prisma.study.findMany({
    where: { projectId },
    include: {
      reportLinks: {
        include: {
          citation: {
            select: {
              id: true,
              title: true,
              authors: true,
              year: true,
              journal: true,
              doi: true,
              pmid: true,
              status: true,
            },
          },
        },
      },
      _count: { select: { extractionForms: true, robAssessments: true } },
    },
    orderBy: { createdAt: "asc" },
  });
}

export async function createStudy(
  ctx: Ctx,
  projectId: string,
  input: z.infer<typeof createStudySchema>,
) {
  await requirePermission(ctx, projectId, "project.edit");
  return prisma.$transaction(async (tx) => {
    if (input.citationId) {
      // R9: body-supplied FK must belong to this project.
      const citation = await tx.citation.findFirst({
        where: { id: input.citationId, projectId },
      });
      if (!citation) throw notFound("Citation");
      // R18 soft rule: one study per report.
      const existingLink = await tx.studyReportLink.findFirst({
        where: { citationId: citation.id },
      });
      if (existingLink) throw conflict("Citation is already linked to a study");
    }
    const study = await tx.study.create({
      data: { projectId, label: input.label, createdById: ctx.userId },
    });
    await audit.record(tx, {
      projectId,
      userId: ctx.userId,
      entityType: "Study",
      entityId: study.id,
      action: AuditActions.STUDY_CREATED,
      newValue: { label: study.label, citationId: input.citationId ?? null },
    });
    if (input.citationId) {
      const link = await tx.studyReportLink.create({
        data: { studyId: study.id, citationId: input.citationId, isPrimaryReport: true },
      });
      await audit.record(tx, {
        projectId,
        userId: ctx.userId,
        entityType: "StudyReportLink",
        entityId: link.id,
        action: AuditActions.STUDY_REPORT_LINKED,
        newValue: { studyId: study.id, citationId: input.citationId, isPrimaryReport: true },
      });
    }
    return tx.study.findUniqueOrThrow({
      where: { id: study.id },
      include: { reportLinks: true },
    });
  });
}

export async function updateStudy(
  ctx: Ctx,
  projectId: string,
  studyId: string,
  input: z.infer<typeof updateStudySchema>,
) {
  await requirePermission(ctx, projectId, "project.edit");
  return prisma.$transaction(async (tx) => {
    const study = await tx.study.findFirst({ where: { id: studyId, projectId } });
    if (!study) throw notFound("Study");
    const updated = await tx.study.update({ where: { id: study.id }, data: input });
    await audit.record(tx, {
      projectId,
      userId: ctx.userId,
      entityType: "Study",
      entityId: study.id,
      action: AuditActions.STUDY_UPDATED,
      previousValue: {
        label: study.label,
        notes: study.notes,
        inQuantitativeSynthesis: study.inQuantitativeSynthesis,
      },
      newValue: {
        label: updated.label,
        notes: updated.notes,
        inQuantitativeSynthesis: updated.inQuantitativeSynthesis,
      },
    });
    return updated;
  });
}

export async function linkReport(
  ctx: Ctx,
  projectId: string,
  studyId: string,
  input: z.infer<typeof linkReportSchema>,
) {
  await requirePermission(ctx, projectId, "project.edit");
  return prisma.$transaction(async (tx) => {
    const study = await tx.study.findFirst({ where: { id: studyId, projectId } });
    if (!study) throw notFound("Study");
    const citation = await tx.citation.findFirst({ where: { id: input.citationId, projectId } });
    if (!citation) throw notFound("Citation");
    // R18 soft rule: a report may belong to at most one study in the MVP.
    const existingLink = await tx.studyReportLink.findFirst({
      where: { citationId: citation.id },
    });
    if (existingLink) {
      throw conflict(
        existingLink.studyId === study.id
          ? "Citation is already linked to this study"
          : "Citation is already linked to another study",
      );
    }
    const link = await tx.studyReportLink.create({
      data: {
        studyId: study.id,
        citationId: citation.id,
        isPrimaryReport: input.isPrimaryReport ?? false,
      },
    });
    await audit.record(tx, {
      projectId,
      userId: ctx.userId,
      entityType: "StudyReportLink",
      entityId: link.id,
      action: AuditActions.STUDY_REPORT_LINKED,
      newValue: {
        studyId: study.id,
        citationId: citation.id,
        isPrimaryReport: link.isPrimaryReport,
      },
    });
    return link;
  });
}

export async function unlinkReport(
  ctx: Ctx,
  projectId: string,
  studyId: string,
  citationId: string,
) {
  await requirePermission(ctx, projectId, "project.edit");
  return prisma.$transaction(async (tx) => {
    const study = await tx.study.findFirst({
      where: { id: studyId, projectId },
      include: { _count: { select: { reportLinks: true, extractionForms: true } } },
    });
    if (!study) throw notFound("Study");
    const link = await tx.studyReportLink.findUnique({
      where: { studyId_citationId: { studyId: study.id, citationId } },
    });
    if (!link) throw notFound("Report link");
    // Refuse to orphan extracted data: a study with extraction forms must keep >= 1 report.
    if (study._count.reportLinks <= 1 && study._count.extractionForms > 0) {
      throw invalidState(
        "Cannot remove the last report of a study that has extraction forms",
      );
    }
    await tx.studyReportLink.delete({ where: { id: link.id } });
    await audit.record(tx, {
      projectId,
      userId: ctx.userId,
      entityType: "StudyReportLink",
      entityId: link.id,
      action: AuditActions.STUDY_REPORT_UNLINKED,
      previousValue: {
        studyId: study.id,
        citationId,
        isPrimaryReport: link.isPrimaryReport,
      },
    });
    return { unlinked: true };
  });
}
