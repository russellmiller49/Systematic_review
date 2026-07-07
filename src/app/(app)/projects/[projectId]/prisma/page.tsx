import { PrismaFlow } from "@/components/prisma/prisma-flow";

export const metadata = { title: "PRISMA - Synthesis" };

export default async function PrismaPage({
  params,
}: {
  params: Promise<{ projectId: string }>;
}) {
  const { projectId } = await params;
  return <PrismaFlow projectId={projectId} />;
}
