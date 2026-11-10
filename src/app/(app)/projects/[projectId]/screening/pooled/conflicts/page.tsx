import { PooledConflictsClient } from "@/components/conflicts/pooled-conflicts-client";

export const metadata = { title: "Pooled adjudication - Synthesis" };

export default async function Page({ params, searchParams }: {
  params: Promise<{ projectId: string }>;
  searchParams: Promise<{ poolId?: string }>;
}) {
  const { projectId } = await params;
  const { poolId } = await searchParams;
  return <PooledConflictsClient guidelineId={projectId} poolId={poolId ?? ""} />;
}
