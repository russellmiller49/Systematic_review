import { SettingsClient } from "@/components/settings/settings-client";

export const metadata = { title: "Settings - Synthesis" };

export default async function SettingsPage({
  params,
}: {
  params: Promise<{ projectId: string }>;
}) {
  const { projectId } = await params;
  return <SettingsClient projectId={projectId} />;
}
