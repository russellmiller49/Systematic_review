import { Suspense } from "react";
import { ManuscriptClient } from "@/components/manuscript/manuscript-page";

export const metadata = { title: "Manuscript - Synthesis" };

export default async function ManuscriptPage({
  params,
}: {
  params: Promise<{ projectId: string }>;
}) {
  const { projectId } = await params;
  // Suspense: ManuscriptClient reads useSearchParams (deep links from notifications).
  return (
    <Suspense>
      <ManuscriptClient projectId={projectId} />
    </Suspense>
  );
}
