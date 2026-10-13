import { ScreeningWorkspace } from "@/components/screening/screening-workspace";
import { getCtx } from "@/server/auth/session";

export const metadata = { title: "Screening - Synthesis" };

export default async function Page({
  params,
}: {
  params: Promise<{ projectId: string }>;
}) {
  const { projectId } = await params;
  const { userId } = await getCtx();
  return (
    <ScreeningWorkspace key={`${projectId}:${userId}`} projectId={projectId} />
  );
}
