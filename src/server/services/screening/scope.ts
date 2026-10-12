import { prisma } from "@/server/db";
import type { Ctx } from "@/server/auth/session";
import { requirePermission } from "@/server/permissions";
import { notFound, invalidState } from "@/server/errors";
import { getGuidelineScreeningConfiguration } from "./pooled";

// Read-only: unlike the protocol editor, never lazily creates a protocol. No decisions,
// accounts, quotas, invitation addresses, or co-reviewer content enter this response.
export async function getScreeningScope(ctx: Ctx, projectId: string, poolId?: string) {
  await requirePermission(ctx, projectId, "project.view");
  let scopeProjects: { id: string; title: string; picoNumber: number | null }[];
  let name: string;
  if (poolId) {
    const configuration = await getGuidelineScreeningConfiguration(ctx, projectId);
    if (configuration.pool?.id !== poolId) throw notFound("Screening pool");
    scopeProjects = configuration.pool.picos;
    name = configuration.pool.name;
    for (const project of scopeProjects) await requirePermission(ctx, project.id, "project.view");
  } else {
    const project = await prisma.project.findUnique({
      where: { id: projectId },
      select: {
        id: true,
        title: true,
        isGuideline: true,
        screeningPoolMembership: true,
      },
    });
    if (!project) throw notFound("Project");
    if (project.isGuideline || project.screeningPoolMembership)
      throw invalidState("Choose the configured screening queue to view its scope");
    scopeProjects = [{ id: project.id, title: project.title, picoNumber: null }];
    name = project.title;
  }
  const projects = await Promise.all(
    scopeProjects.map(async (project) => {
      const protocol = await prisma.protocol.findUnique({
        where: { projectId: project.id },
        select: {
          reviewQuestion: true,
          population: true,
          intervention: true,
          comparator: true,
          outcomesNarrative: true,
          studyDesigns: true,
          setting: true,
          dateRestrictionFrom: true,
          dateRestrictionTo: true,
          languageRestrictions: true,
          updatedAt: true,
          picoQuestions: {
            orderBy: { order: "asc" },
            select: {
              question: true,
              population: true,
              intervention: true,
              comparator: true,
              outcome: true,
            },
          },
          criteria: {
            orderBy: [{ type: "asc" }, { order: "asc" }],
            select: {
              type: true,
              category: true,
              text: true,
            },
          },
          versions: {
            orderBy: { versionNumber: "desc" },
            take: 1,
            select: { versionNumber: true, createdAt: true },
          },
        },
      });
      return { ...project, protocol };
    }),
  );
  return { name, combined: Boolean(poolId), projects };
}
