import { ProtocolPage } from "@/components/protocol/protocol-page";

export const metadata = { title: "Protocol - Synthesis" };

export default async function Page({
  params,
}: {
  params: Promise<{ projectId: string }>;
}) {
  const { projectId } = await params;
  return <ProtocolPage projectId={projectId} />;
}
