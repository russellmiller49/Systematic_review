import { handleRoute, ok } from "@/server/api-utils";
import { getCtx } from "@/server/auth/session";
import { prisma } from "@/server/db";
import { notFound } from "@/server/errors";
import { requirePermission } from "@/server/permissions";
import { resolveStudyPdf } from "@/server/services/ai-extraction";

type Params = { params: Promise<{ projectId: string; studyId: string }> };

// The study's primary-report PDF descriptor (or null). project.view — evidence viewing
// must work for every member who can see the study, independent of AI being enabled.
export async function GET(_req: Request, { params }: Params) {
  return handleRoute(async () => {
    const ctx = await getCtx();
    const { projectId, studyId } = await params;
    await requirePermission(ctx, projectId, "project.view");
    const study = await prisma.study.findFirst({ where: { id: studyId, projectId } });
    if (!study) throw notFound("Study");
    const file = await resolveStudyPdf(projectId, studyId);
    return ok({
      pdf: file ? { fileId: file.id, filename: file.filename, sizeBytes: file.sizeBytes } : null,
    });
  });
}
