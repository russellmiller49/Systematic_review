import { DedupClient } from "@/components/dedup/dedup-client";

export const metadata = { title: "Deduplication - Synthesis" };

export default async function Page({ params }: { params: Promise<{ projectId: string }> }) {
  const { projectId } = await params;
  return <DedupClient projectId={projectId} />;
}
