import * as React from "react";
import { Loader2, type LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";

export function Spinner({ className }: { className?: string }) {
  return <Loader2 className={cn("h-4 w-4 animate-spin", className)} />;
}

export function Skeleton({ className }: { className?: string }) {
  return <div className={cn("animate-pulse rounded-md bg-muted", className)} />;
}

export function Separator({ className }: { className?: string }) {
  return <div className={cn("h-px w-full bg-border", className)} />;
}

export function Progress({ value, className }: { value: number; className?: string }) {
  const pct = Math.max(0, Math.min(100, value));
  return (
    <div className={cn("h-2 w-full overflow-hidden rounded-full bg-muted", className)}>
      <div className="h-full rounded-full bg-primary transition-all" style={{ width: `${pct}%` }} />
    </div>
  );
}

export function EmptyState({
  icon: Icon,
  title,
  description,
  action,
}: {
  icon?: LucideIcon;
  title: string;
  description?: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 rounded-lg border border-dashed border-border px-6 py-14 text-center">
      {Icon && <Icon className="h-9 w-9 text-muted-foreground/60" />}
      <p className="font-medium">{title}</p>
      {description && <p className="max-w-md text-sm text-muted-foreground">{description}</p>}
      {action && <div className="mt-3">{action}</div>}
    </div>
  );
}

export function Alert({
  variant = "info",
  children,
  className,
}: {
  variant?: "info" | "warning" | "error" | "success";
  children: React.ReactNode;
  className?: string;
}) {
  const styles = {
    info: "border-accent-foreground/20 bg-accent text-accent-foreground",
    warning: "border-maybe/30 bg-maybe-muted text-maybe",
    error: "border-exclude/30 bg-exclude-muted text-exclude",
    success: "border-include/30 bg-include-muted text-include",
  }[variant];
  return (
    <div className={cn("rounded-md border px-4 py-3 text-sm", styles, className)}>{children}</div>
  );
}
