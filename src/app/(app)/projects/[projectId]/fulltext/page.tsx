import { FullTextQueueClient } from "@/components/fulltext/fulltext-queue";

export const metadata = { title: "Full Text - Synthesis" };

export default async function FullTextPage({
  params,
}: {
  params: Promise<{ projectId: string }>;
}) {
  const { projectId } = await params;
  return <FullTextQueueClient projectId={projectId} />;
}
