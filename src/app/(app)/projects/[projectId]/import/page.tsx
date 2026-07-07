import { ImportClient } from "@/components/imports/import-client";

export const metadata = { title: "Import - Synthesis" };

export default async function Page({ params }: { params: Promise<{ projectId: string }> }) {
  const { projectId } = await params;
  return <ImportClient projectId={projectId} />;
}
