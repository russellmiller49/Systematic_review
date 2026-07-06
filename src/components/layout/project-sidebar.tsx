"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  BarChart3,
  ClipboardList,
  FileSearch,
  FileText,
  FileUp,
  GitMerge,
  History,
  LayoutDashboard,
  ListChecks,
  Scale,
  Settings,
  Swords,
  Table2,
} from "lucide-react";
import { api } from "@/lib/api";
import { cn } from "@/lib/utils";

const NAV = [
  { href: "", label: "Dashboard", icon: LayoutDashboard },
  { href: "/protocol", label: "Protocol", icon: ClipboardList },
  { href: "/import", label: "Import", icon: FileUp },
  { href: "/dedup", label: "Deduplication", icon: GitMerge },
  { href: "/screening", label: "Screening", icon: ListChecks },
  { href: "/conflicts", label: "Conflicts", icon: Swords },
  { href: "/fulltext", label: "Full text", icon: FileSearch },
  { href: "/extraction", label: "Extraction", icon: Table2 },
  { href: "/rob", label: "Risk of bias", icon: Scale },
  { href: "/prisma", label: "PRISMA", icon: BarChart3 },
  { href: "/audit", label: "Audit trail", icon: History },
  { href: "/settings", label: "Settings", icon: Settings },
] as const;

export function ProjectSidebar({ projectId }: { projectId: string }) {
  const pathname = usePathname();
  const base = `/projects/${projectId}`;
  const [title, setTitle] = useState<string | null>(null);

  useEffect(() => {
    api<{ title: string }>(`/api/projects/${projectId}`)
      .then((p) => setTitle(p.title))
      .catch(() => setTitle(null));
  }, [projectId]);

  return (
    <aside className="sticky top-14 hidden h-[calc(100vh-3.5rem)] w-56 shrink-0 flex-col gap-1 overflow-y-auto border-r border-border p-3 md:flex">
      <div className="mb-2 px-2">
        <p className="flex items-center gap-1.5 truncate text-sm font-medium" title={title ?? ""}>
          <FileText className="h-4 w-4 shrink-0 text-muted-foreground" />
          {title ?? "…"}
        </p>
      </div>
      {NAV.map(({ href, label, icon: Icon }) => {
        const full = `${base}${href}`;
        const active = href === "" ? pathname === base : pathname.startsWith(full);
        return (
          <Link
            key={href}
            href={full}
            className={cn(
              "flex items-center gap-2.5 rounded-md px-2.5 py-1.5 text-sm transition-colors",
              active
                ? "bg-accent font-medium text-accent-foreground"
                : "text-muted-foreground hover:bg-muted hover:text-foreground",
            )}
          >
            <Icon className="h-4 w-4" />
            {label}
          </Link>
        );
      })}
    </aside>
  );
}
