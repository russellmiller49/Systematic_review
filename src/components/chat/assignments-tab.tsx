"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Check, ClipboardList } from "lucide-react";
import { toast } from "sonner";
import { api, apiPost, ApiError } from "@/lib/api";
import { mentionsToPlainText } from "@/lib/chat/mentions";
import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { EmptyState, Skeleton } from "@/components/ui/misc";
import type { AssignmentListItem } from "./types";

export function AssignmentsTab({
  projectId,
  meId,
  canAssign,
  onOpenChannel,
}: {
  projectId: string;
  meId: string | null;
  canAssign: boolean;
  onOpenChannel: (channelId: string, messageId: string) => void;
}) {
  const [items, setItems] = useState<AssignmentListItem[] | null>(null);
  const [scope, setScope] = useState<"mine" | "all">(canAssign ? "all" : "mine");
  const [statusFilter, setStatusFilter] = useState<"open" | "done" | "all">("open");

  const load = useCallback(() => {
    api<AssignmentListItem[]>(
      `/api/projects/${projectId}/chat/assignments?mine=${scope === "mine" ? "true" : "false"}`,
    )
      .then(setItems)
      .catch((err) => {
        setItems([]);
        toast.error(err instanceof ApiError ? err.message : "Failed to load assignments");
      });
  }, [projectId, scope]);

  useEffect(() => {
    setItems(null);
    load();
  }, [load]);

  const visible = useMemo(() => {
    if (!items) return null;
    return items.filter((item) => {
      if (statusFilter === "open") return item.status === "PENDING";
      if (statusFilter === "done") return item.status === "COMPLETED";
      return true;
    });
  }, [items, statusFilter]);

  async function complete(item: AssignmentListItem) {
    try {
      await apiPost(`/api/projects/${projectId}/chat/assignments/${item.id}/complete`);
      toast.success("Marked done");
      load();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Failed to mark the task done");
    }
  }

  const chip = (
    active: boolean,
    onClick: () => void,
    label: string,
  ) => (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "rounded-full border px-2.5 py-1 text-xs font-medium transition-colors",
        active
          ? "border-transparent bg-primary text-primary-foreground"
          : "border-border bg-background text-muted-foreground hover:bg-muted",
      )}
    >
      {label}
    </button>
  );

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-x-6 gap-y-2">
        {canAssign && (
          <div className="flex items-center gap-1.5">
            <span className="text-xs font-medium text-muted-foreground">Show:</span>
            {chip(scope === "all", () => setScope("all"), "Everyone's")}
            {chip(scope === "mine", () => setScope("mine"), "Mine")}
          </div>
        )}
        <div className="flex items-center gap-1.5">
          <span className="text-xs font-medium text-muted-foreground">Status:</span>
          {chip(statusFilter === "open", () => setStatusFilter("open"), "Open")}
          {chip(statusFilter === "done", () => setStatusFilter("done"), "Done")}
          {chip(statusFilter === "all", () => setStatusFilter("all"), "All")}
        </div>
      </div>

      {visible === null ? (
        <Skeleton className="h-40" />
      ) : visible.length === 0 ? (
        <EmptyState
          icon={ClipboardList}
          title="No assignments here"
          description='Owners and admins can turn any chat message into an assignment with the "Assignment" toggle in the composer.'
        />
      ) : (
        <div className="space-y-2">
          {visible.map((item) => (
            <div key={item.id} className="rounded-lg border border-border bg-card p-3">
              <div className="flex flex-wrap items-start justify-between gap-2">
                <button
                  type="button"
                  className="min-w-0 flex-1 text-left"
                  onClick={() => onOpenChannel(item.message.channelId, item.message.id)}
                  title="Open in chat"
                >
                  <p className="text-sm leading-snug">
                    {item.message.body
                      ? mentionsToPlainText(item.message.body)
                      : "(message deleted)"}
                  </p>
                  <p className="mt-0.5 text-xs text-muted-foreground">
                    From {item.message.author.name} ·{" "}
                    {new Date(item.message.createdAt).toLocaleDateString()}
                    {item.dueAt ? ` · due ${new Date(item.dueAt).toLocaleDateString()}` : ""}
                  </p>
                </button>
                <div className="flex shrink-0 items-center gap-2">
                  {scope === "all" && <Badge variant="secondary">{item.assignee.name}</Badge>}
                  <Badge
                    variant={
                      item.status === "COMPLETED"
                        ? "include"
                        : item.status === "VOIDED"
                          ? "muted"
                          : "maybe"
                    }
                  >
                    {item.status.toLowerCase()}
                  </Badge>
                  {item.status === "PENDING" && item.assignee.id === meId && (
                    <Button size="sm" variant="outline" className="h-7" onClick={() => void complete(item)}>
                      <Check /> Mark done
                    </Button>
                  )}
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
