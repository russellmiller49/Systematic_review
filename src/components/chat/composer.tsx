"use client";

import { useRef, useState } from "react";
import { AtSign, ClipboardList, Send } from "lucide-react";
import { toast } from "sonner";
import { apiPost, ApiError } from "@/lib/api";
import { insertMention } from "@/lib/chat/mentions";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Textarea } from "@/components/ui/textarea";
import type { MemberRef } from "@/components/manuscript/types";
import type { MessageView } from "./types";

export function Composer({
  projectId,
  channelId,
  parentId,
  members,
  meId,
  canAssign,
  placeholder,
  onPosted,
}: {
  projectId: string;
  channelId: string;
  parentId?: string;
  members: MemberRef[];
  meId: string | null;
  canAssign: boolean;
  placeholder: string;
  onPosted: (message: MessageView) => void;
}) {
  const [body, setBody] = useState("");
  const [busy, setBusy] = useState(false);
  const [mentionOpen, setMentionOpen] = useState(false);
  const [assignmentMode, setAssignmentMode] = useState(false);
  const [assignees, setAssignees] = useState<Set<string>>(new Set());
  const [dueAt, setDueAt] = useState("");
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  const active = members.filter((m) => m.status === "ACTIVE");

  async function post() {
    if (!body.trim() || busy) return;
    setBusy(true);
    try {
      const message = await apiPost<MessageView>(
        `/api/projects/${projectId}/chat/channels/${channelId}/messages`,
        {
          body: body.trim(),
          parentId,
          ...(assignmentMode
            ? {
                assignment: {
                  ...(assignees.size > 0 ? { assigneeIds: [...assignees] } : {}),
                  ...(dueAt ? { dueAt: new Date(dueAt).toISOString() } : {}),
                },
              }
            : {}),
        },
      );
      setBody("");
      setAssignmentMode(false);
      setAssignees(new Set());
      setDueAt("");
      onPosted(message);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Failed to send the message");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-1.5">
      <Textarea
        ref={textareaRef}
        rows={parentId ? 2 : 3}
        placeholder={placeholder}
        value={body}
        onChange={(e) => setBody(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            void post();
          }
        }}
      />
      {assignmentMode && (
        <div className="space-y-2 rounded-md border border-border bg-muted/40 p-2.5">
          <p className="text-xs font-medium">
            Assign to {assignees.size === 0 ? "the whole team" : `${assignees.size} member(s)`}:
          </p>
          <div className="flex flex-wrap gap-2">
            {active
              .filter((m) => m.user.id !== meId)
              .map((member) => (
                <label key={member.user.id} className="flex items-center gap-1.5 text-xs">
                  <input
                    type="checkbox"
                    className="h-3.5 w-3.5 accent-primary"
                    checked={assignees.has(member.user.id)}
                    onChange={(e) =>
                      setAssignees((prev) => {
                        const next = new Set(prev);
                        if (e.target.checked) next.add(member.user.id);
                        else next.delete(member.user.id);
                        return next;
                      })
                    }
                  />
                  {member.user.name}
                </label>
              ))}
          </div>
          <div className="flex items-center gap-2">
            <label htmlFor="assignment-due" className="text-xs text-muted-foreground">
              Due
            </label>
            <Input
              id="assignment-due"
              type="date"
              className="h-7 w-40 text-xs"
              value={dueAt}
              onChange={(e) => setDueAt(e.target.value)}
            />
          </div>
        </div>
      )}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-1">
          <Popover open={mentionOpen} onOpenChange={setMentionOpen}>
            <PopoverTrigger asChild>
              <Button variant="ghost" size="sm" className="h-7 px-2 text-xs" type="button">
                <AtSign /> Mention
              </Button>
            </PopoverTrigger>
            <PopoverContent className="w-56 p-1.5">
              <button
                type="button"
                className="block w-full rounded px-2 py-1.5 text-left text-sm hover:bg-muted"
                onClick={() => {
                  setBody((prev) => `${prev}${prev && !prev.endsWith(" ") ? " " : ""}@channel `);
                  setMentionOpen(false);
                  textareaRef.current?.focus();
                }}
              >
                @channel <span className="text-xs text-muted-foreground">(everyone)</span>
              </button>
              {active
                .filter((m) => m.user.id !== meId)
                .map((member) => (
                  <button
                    key={member.user.id}
                    type="button"
                    className="block w-full rounded px-2 py-1.5 text-left text-sm hover:bg-muted"
                    onClick={() => {
                      setBody((prev) => insertMention(prev, member.user.name, member.user.id));
                      setMentionOpen(false);
                      textareaRef.current?.focus();
                    }}
                  >
                    {member.user.name}
                  </button>
                ))}
            </PopoverContent>
          </Popover>
          {canAssign && !parentId && (
            <Button
              variant={assignmentMode ? "secondary" : "ghost"}
              size="sm"
              className="h-7 px-2 text-xs"
              type="button"
              onClick={() => setAssignmentMode((v) => !v)}
              title="Send this message as an assignment with done-tracking"
            >
              <ClipboardList /> Assignment
            </Button>
          )}
        </div>
        <Button size="sm" className="h-7" disabled={busy || !body.trim()} onClick={() => void post()}>
          <Send /> Send
        </Button>
      </div>
    </div>
  );
}
