import { ProjectSidebar } from "@/components/layout/project-sidebar";

export default async function ProjectLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ projectId: string }>;
}) {
  const { projectId } = await params;
  return (
    <div className="flex w-full">
      <ProjectSidebar projectId={projectId} />
      <main className="min-w-0 flex-1 px-6 py-6">{children}</main>
    </div>
  );
}
