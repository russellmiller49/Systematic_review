import { ScreeningWorkspace } from "@/components/screening/screening-workspace";

export const metadata = { title: "Screening - Synthesis" };

export default async function Page({
  params,
}: {
  params: Promise<{ projectId: string }>;
}) {
  const { projectId } = await params;
  return <ScreeningWorkspace projectId={projectId} />;
}
