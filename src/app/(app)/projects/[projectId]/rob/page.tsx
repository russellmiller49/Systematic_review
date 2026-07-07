import { RobPage } from "@/components/rob/rob-page";

export const metadata = { title: "Risk of bias - Synthesis" };

export default async function Page({ params }: { params: Promise<{ projectId: string }> }) {
  const { projectId } = await params;
  return <RobPage projectId={projectId} />;
}
