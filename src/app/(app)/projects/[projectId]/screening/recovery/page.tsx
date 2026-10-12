import { getCtx } from "@/server/auth/session";
import { can, getMembership } from "@/server/permissions";
import { RecoveryClient } from "@/components/screening/recovery-client";

export const metadata = { title: "Screening recovery - Synthesis" };
export default async function RecoveryPage({
  params,
}: {
  params: Promise<{ projectId: string }>;
}) {
  const { projectId } = await params;
  const ctx = await getCtx();
  const member = await getMembership(ctx.userId, projectId);
  if (!member || !can(member.roles, "project.edit"))
    return (
      <div className="p-6">
        <h1 className="text-xl font-semibold">Screening recovery</h1>
        <p>
          Only current project owners and administrators can access screening
          recovery.
        </p>
      </div>
    );
  return <RecoveryClient guidelineId={projectId} />;
}
