import { OrgList } from "@/components/orgs/org-list";

export const metadata = { title: "Organizations" };

export default function OrgsPage() {
  return (
    <main className="mx-auto w-full max-w-5xl px-6 py-8">
      <OrgList />
    </main>
  );
}
