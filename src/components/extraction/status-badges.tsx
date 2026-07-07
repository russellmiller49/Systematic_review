import { Badge } from "@/components/ui/badge";
import type { ConflictStatus, FormStatus, TemplateStatus } from "./types";

export function TemplateStatusBadge({ status }: { status: TemplateStatus }) {
  const variant = status === "PUBLISHED" ? "include" : status === "DRAFT" ? "maybe" : "muted";
  return <Badge variant={variant}>{status.toLowerCase()}</Badge>;
}

export function FormStatusBadge({ status }: { status: FormStatus }) {
  return (
    <Badge variant={status === "COMPLETED" ? "include" : "secondary"}>
      {status === "COMPLETED" ? "completed" : "in progress"}
    </Badge>
  );
}

export function ConflictStatusBadge({ status }: { status: ConflictStatus }) {
  const variant = status === "OPEN" ? "maybe" : status === "RESOLVED" ? "include" : "muted";
  return <Badge variant={variant}>{status.toLowerCase()}</Badge>;
}
