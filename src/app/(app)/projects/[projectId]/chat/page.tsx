import { Suspense } from "react";
import { ChatClient } from "@/components/chat/chat-client";

export const metadata = { title: "Team Chat - Synthesis" };

export default async function ChatPage({
  params,
}: {
  params: Promise<{ projectId: string }>;
}) {
  const { projectId } = await params;
  // Suspense: ChatClient reads useSearchParams (deep links from notifications).
  return (
    <Suspense>
      <ChatClient projectId={projectId} />
    </Suspense>
  );
}
