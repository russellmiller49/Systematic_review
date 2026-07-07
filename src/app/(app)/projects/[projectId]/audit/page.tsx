import { AuditLog } from "@/components/audit/audit-log";

export const metadata = { title: "Audit trail - Synthesis" };

export default async function AuditPage({
  params,
}: {
  params: Promise<{ projectId: string }>;
}) {
  const { projectId } = await params;
  return <AuditLog projectId={projectId} />;
}
