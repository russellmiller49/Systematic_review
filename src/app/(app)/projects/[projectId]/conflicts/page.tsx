import { ConflictsClient } from "@/components/conflicts/conflicts-client";

export const metadata = { title: "Conflicts - Synthesis" };

export default async function ConflictsPage({
  params,
}: {
  params: Promise<{ projectId: string }>;
}) {
  const { projectId } = await params;
  return <ConflictsClient projectId={projectId} />;
}
