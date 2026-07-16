import { AnalysisClient } from "@/components/analysis/analysis-page";

export const metadata = { title: "Analysis - Synthesis" };

export default async function AnalysisPage({
  params,
}: {
  params: Promise<{ projectId: string }>;
}) {
  const { projectId } = await params;
  return <AnalysisClient projectId={projectId} />;
}
