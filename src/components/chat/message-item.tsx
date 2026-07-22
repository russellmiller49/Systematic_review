"use client";

import { Check, ClipboardList, MessageSquare, Pencil, Trash2 } from "lucide-react";
import { splitMentionSegments } from "@/lib/chat/mentions";
import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import type { MessageView } from "./types";

export function MessageBody({ body, meId }: { body: string; meId: string | null }) {
  const segments = splitMentionSegments(body);
  return (
    <p className="whitespace-pre-line text-sm leading-relaxed">
      {segments.map((segment, i) => {
        if (segment.type === "text") return <span key={i}>{segment.text}</span>;
        if (segment.type === "channel") {
          return (
            <span key={i} className="rounded bg-maybe-muted px-1 font-medium text-maybe">
              @channel
            </span>
          );
        }
        return (
          <span
            key={i}
            className={cn(
              "rounded px-1 font-medium",
              segment.userId === meId
                ? "bg-maybe-muted text-maybe"
                : "bg-accent text-accent-foreground",
            )}
          >
            @{segment.name}
          </span>
        );
      })}
    </p>
  );
}

export function MessageItem({
  message,
  meId,
  canManage,
  onOpenThread,
  onEdit,
  onDelete,
  onCompleteTask,
  isThreadChild = false,
}: {
  message: MessageView;
  meId: string | null;
  canManage: boolean;
  onOpenThread?: (message: MessageView) => void;
  onEdit: (message: MessageView) => void;
  onDelete: (message: MessageView) => void;
  onCompleteTask: (taskId: string) => void;
  isThreadChild?: boolean;
}) {
  const own = message.author.id === meId;
  const myTask = message.assignmentTasks.find((t) => t.assigneeId === meId);

  return (
    <div className={cn("group rounded-md px-2 py-1.5 hover:bg-muted/60", isThreadChild && "py-1")}>
      <div className="flex items-baseline justify-between gap-2">
        <p className="text-xs">
          <span className="font-semibold">{message.author.name}</span>{" "}
          <span className="text-muted-foreground">
            {new Date(message.createdAt).toLocaleTimeString([], {
              hour: "2-digit",
              minute: "2-digit",
            })}
          </span>
          {message.editedAt && !message.deleted && (
            <span className="text-muted-foreground"> (edited)</span>
          )}
        </p>
        {!message.deleted && (own || canManage) && (
          <span className="hidden items-center gap-0.5 group-hover:flex">
            {own && (
              <button
                type="button"
                className="rounded p-1 text-muted-foreground hover:bg-background"
                onClick={() => onEdit(message)}
                title="Edit message"
              >
                <Pencil className="h-3 w-3" />
              </button>
            )}
            <button
              type="button"
              className="rounded p-1 text-muted-foreground hover:bg-background hover:text-destructive"
              onClick={() => onDelete(message)}
              title="Delete message"
            >
              <Trash2 className="h-3 w-3" />
            </button>
          </span>
        )}
      </div>

      {message.deleted ? (
        <p className="text-sm italic text-muted-foreground">This message was deleted.</p>
      ) : (
        <MessageBody body={message.body ?? ""} meId={meId} />
      )}

      {message.kind === "ASSIGNMENT" && !message.deleted && (
        <div className="mt-1.5 rounded-md border border-border bg-muted/40 p-2">
          <p className="flex items-center gap-1.5 text-xs font-medium">
            <ClipboardList className="h-3.5 w-3.5" /> Assignment
            {message.assignmentTasks[0]?.dueAt && (
              <span className="text-muted-foreground">
                · due {new Date(message.assignmentTasks[0].dueAt).toLocaleDateString()}
              </span>
            )}
          </p>
          <div className="mt-1.5 flex flex-wrap gap-1.5">
            {message.assignmentTasks.map((task) => (
              <Badge
                key={task.id}
                variant={
                  task.status === "COMPLETED"
                    ? "include"
                    : task.status === "VOIDED"
                      ? "muted"
                      : "outline"
                }
                title={task.status.toLowerCase()}
              >
                {task.status === "COMPLETED" && <Check className="mr-0.5 h-3 w-3" />}
                {task.assignee.name}
              </Badge>
            ))}
          </div>
          {myTask?.status === "PENDING" && (
            <Button
              size="sm"
              variant="outline"
              className="mt-2 h-7"
              onClick={() => onCompleteTask(myTask.id)}
            >
              <Check /> Mark done
            </Button>
          )}
        </div>
      )}

      {!isThreadChild && onOpenThread && !message.deleted && (
        <button
          type="button"
          className="mt-1 hidden items-center gap-1 text-xs text-primary hover:underline group-hover:inline-flex"
          onClick={() => onOpenThread(message)}
        >
          <MessageSquare className="h-3 w-3" /> Reply in thread
        </button>
      )}
      {!isThreadChild && message.replyCount > 0 && onOpenThread && (
        <button
          type="button"
          className="mt-1 inline-flex items-center gap-1 text-xs text-primary hover:underline"
          onClick={() => onOpenThread(message)}
        >
          <MessageSquare className="h-3 w-3" /> {message.replyCount}{" "}
          {message.replyCount === 1 ? "reply" : "replies"}
        </button>
      )}
    </div>
  );
}
