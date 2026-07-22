import { ReferencesClient } from "@/components/references/references-client";

export const metadata = { title: "References - Synthesis" };

export default async function ReferencesPage({
  params,
}: {
  params: Promise<{ projectId: string }>;
}) {
  const { projectId } = await params;
  return <ReferencesClient projectId={projectId} />;
}
