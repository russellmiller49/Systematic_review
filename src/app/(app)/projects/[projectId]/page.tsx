import { ProjectDashboard } from "@/components/dashboard/project-dashboard";

export const metadata = { title: "Dashboard - Synthesis" };

export default async function ProjectPage({
  params,
}: {
  params: Promise<{ projectId: string }>;
}) {
  const { projectId } = await params;
  return <ProjectDashboard projectId={projectId} />;
}
