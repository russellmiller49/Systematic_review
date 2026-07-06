import { OrgDashboard } from "@/components/orgs/org-dashboard";

export const metadata = { title: "Organization" };

export default async function OrgPage({ params }: { params: Promise<{ orgId: string }> }) {
  const { orgId } = await params;
  return (
    <main className="mx-auto w-full max-w-5xl px-6 py-8">
      <OrgDashboard orgId={orgId} />
    </main>
  );
}
