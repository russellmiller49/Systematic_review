// Project dashboard: aggregated stats (project.view) + recent activity routed through the
// R1 blind filter by reusing listAuditEvents (callers without audit.view get an empty feed).

import { prisma } from "@/server/db";
import { notFound } from "@/server/errors";
import type { Ctx } from "@/server/auth/session";
import { requirePermission, can } from "@/server/permissions";
import { listAuditEvents, type AuditEventRow } from "@/server/services/audit-query";

const RECENT_ACTIVITY_LIMIT = 15;

export interface StageStats {
  type: string;
  assigned: number;
  decided: number;
  openConflicts: number;
  results: { include: number; exclude: number };
}

export interface DashboardData {
  project: { id: string; title: string; reviewType: string; status: string };
  stats: {
    citations: { total: number; active: number; duplicates: number };
    screening: StageStats[];
    fulltext: { sought: number; retrieved: number; notRetrieved: number };
    extraction: { forms: number; completed: number; openConflicts: number };
    rob: { assessments: number; completed: number; openConflicts: number };
    studies: { total: number; inQuantitativeSynthesis: number };
  };
  recentActivity: AuditEventRow[];
}

export async function getDashboard(ctx: Ctx, projectId: string): Promise<DashboardData> {
  const member = await requirePermission(ctx, projectId, "project.view");

  const project = await prisma.project.findFirst({
    where: { id: projectId },
    select: { id: true, title: true, reviewType: true, status: true },
  });
  if (!project) throw notFound("Project");

  // -- citations -------------------------------------------------------------------------------
  const [citationsTotal, citationsActive, citationsDuplicate] = await Promise.all([
    prisma.citation.count({ where: { projectId } }),
    prisma.citation.count({ where: { projectId, status: "ACTIVE" } }),
    prisma.citation.count({ where: { projectId, status: "DUPLICATE" } }),
  ]);

  // -- screening (per stage; ACTIVE citations only — R8) ----------------------------------------
  const stages = await prisma.screeningStage.findMany({
    where: { projectId },
    orderBy: { createdAt: "asc" },
    select: { id: true, type: true },
  });
  const screening: StageStats[] = await Promise.all(
    stages.map(async (stage) => {
      const [assigned, decided, openConflicts, include, exclude] = await Promise.all([
        prisma.screeningAssignment.count({
          where: { stageId: stage.id, status: { not: "VOIDED" }, citation: { status: "ACTIVE" } },
        }),
        prisma.screeningDecision.count({
          where: { stageId: stage.id, citation: { status: "ACTIVE" } },
        }),
        prisma.screeningConflict.count({ where: { stageId: stage.id, status: "OPEN" } }),
        prisma.citationStageResult.count({
          where: { stageId: stage.id, outcome: "INCLUDE", citation: { status: "ACTIVE" } },
        }),
        prisma.citationStageResult.count({
          where: { stageId: stage.id, outcome: "EXCLUDE", citation: { status: "ACTIVE" } },
        }),
      ]);
      return { type: stage.type, assigned, decided, openConflicts, results: { include, exclude } };
    }),
  );

  // -- full text -------------------------------------------------------------------------------
  const soughtWhere = {
    projectId,
    status: "ACTIVE",
    stageResults: { some: { stage: { type: "TITLE_ABSTRACT" }, outcome: "INCLUDE" } },
  } as const;
  const [sought, retrieved, soughtWithoutFile] = await Promise.all([
    prisma.citation.count({ where: soughtWhere }),
    prisma.citation.count({ where: { ...soughtWhere, fullTextLinks: { some: {} } } }),
    prisma.citation.findMany({
      where: { ...soughtWhere, fullTextLinks: { none: {} } },
      select: {
        retrievalAttempts: {
          orderBy: [{ attemptedAt: "desc" }, { id: "desc" }],
          take: 1,
          select: { outcome: true },
        },
      },
    }),
  ]);
  const notRetrieved = soughtWithoutFile.filter(
    (c) => c.retrievalAttempts[0]?.outcome === "NOT_RETRIEVED",
  ).length;

  // -- extraction ------------------------------------------------------------------------------
  const [forms, formsCompleted, extractionOpenConflicts] = await Promise.all([
    prisma.extractionForm.count({ where: { study: { projectId } } }),
    prisma.extractionForm.count({ where: { study: { projectId }, status: "COMPLETED" } }),
    prisma.extractionConflict.count({ where: { study: { projectId }, status: "OPEN" } }),
  ]);

  // -- risk of bias ----------------------------------------------------------------------------
  const [assessments, assessmentsCompleted, robOpenConflicts] = await Promise.all([
    prisma.riskOfBiasAssessment.count({ where: { study: { projectId } } }),
    prisma.riskOfBiasAssessment.count({ where: { study: { projectId }, status: "COMPLETED" } }),
    prisma.riskOfBiasConflict.count({ where: { study: { projectId }, status: "OPEN" } }),
  ]);

  // -- studies ---------------------------------------------------------------------------------
  const [studiesTotal, studiesQuant] = await Promise.all([
    prisma.study.count({ where: { projectId } }),
    prisma.study.count({ where: { projectId, inQuantitativeSynthesis: true } }),
  ]);

  // -- recent activity through the R1 blind filter ----------------------------------------------
  const recentActivity = can(member.roles, "audit.view")
    ? (await listAuditEvents(ctx, projectId, { limit: RECENT_ACTIVITY_LIMIT })).events
    : [];

  return {
    project,
    stats: {
      citations: {
        total: citationsTotal,
        active: citationsActive,
        duplicates: citationsDuplicate,
      },
      screening,
      fulltext: { sought, retrieved, notRetrieved },
      extraction: { forms, completed: formsCompleted, openConflicts: extractionOpenConflicts },
      rob: { assessments, completed: assessmentsCompleted, openConflicts: robOpenConflicts },
      studies: { total: studiesTotal, inQuantitativeSynthesis: studiesQuant },
    },
    recentActivity,
  };
}
