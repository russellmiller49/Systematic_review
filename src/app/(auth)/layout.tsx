import Link from "next/link";
import { BookOpenCheck } from "lucide-react";

export default function AuthLayout({ children }: { children: React.ReactNode }) {
  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-6 bg-muted/40 px-4">
      <Link href="/" className="flex items-center gap-2 text-primary">
        <BookOpenCheck className="h-6 w-6" />
        <span className="text-lg font-semibold tracking-tight">Synthesis</span>
      </Link>
      <div className="w-full max-w-sm">{children}</div>
    </main>
  );
}
