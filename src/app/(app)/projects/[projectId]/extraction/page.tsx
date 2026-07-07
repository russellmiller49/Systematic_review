import { ExtractionClient } from "@/components/extraction/extraction-page";

export const metadata = { title: "Extraction - Synthesis" };

export default async function ExtractionPage({
  params,
}: {
  params: Promise<{ projectId: string }>;
}) {
  const { projectId } = await params;
  return <ExtractionClient projectId={projectId} />;
}
