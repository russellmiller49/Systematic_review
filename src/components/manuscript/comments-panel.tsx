"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { AtSign, Check, MessageSquare, RotateCcw, Send, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { api, apiDelete, apiPatch, apiPost, ApiError } from "@/lib/api";
import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { EmptyState, Skeleton } from "@/components/ui/misc";
import { Textarea } from "@/components/ui/textarea";
import type { CommentView, MemberRef, UserRef } from "./types";

const POLL_MS = 10_000;

export function CommentsPanel({
  projectId,
  sectionId,
  me,
  members,
  canComment,
  canManage,
}: {
  projectId: string;
  sectionId: string;
  me: UserRef | null;
  members: MemberRef[];
  canComment: boolean;
  canManage: boolean;
}) {
  const [comments, setComments] = useState<CommentView[] | null>(null);
  const [filter, setFilter] = useState<"OPEN" | "RESOLVED">("OPEN");
  const [replyTo, setReplyTo] = useState<string | null>(null);

  const base = `/api/projects/${projectId}/manuscript/sections/${sectionId}/comments`;

  const load = useCallback(() => {
    api<CommentView[]>(`${base}?status=${filter}`)
      .then(setComments)
      .catch(() => setComments([]));
  }, [base, filter]);

  useEffect(() => {
    setComments(null);
    load();
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") load();
    }, POLL_MS);
    const onFocus = () => load();
    window.addEventListener("focus", onFocus);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("focus", onFocus);
    };
  }, [load]);

  async function setStatus(comment: CommentView, status: "OPEN" | "RESOLVED") {
    try {
      await apiPatch(`${base}/${comment.id}`, { status });
      load();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Failed to update the comment");
    }
  }

  async function remove(comment: CommentView) {
    if (!window.confirm("Delete this comment?")) return;
    try {
      await apiDelete(`${base}/${comment.id}`);
      load();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Failed to delete the comment");
    }
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center justify-between border-b border-border pb-2">
        <p className="text-sm font-medium">Comments</p>
        <div className="flex gap-1">
          {(["OPEN", "RESOLVED"] as const).map((value) => (
            <button
              key={value}
              type="button"
              onClick={() => setFilter(value)}
              className={cn(
                "rounded-full border px-2 py-0.5 text-xs font-medium",
                filter === value
                  ? "border-transparent bg-primary text-primary-foreground"
                  : "border-border text-muted-foreground hover:bg-muted",
              )}
            >
              {value === "OPEN" ? "Open" : "Resolved"}
            </button>
          ))}
        </div>
      </div>

      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto py-3">
        {comments === null ? (
          <Skeleton className="h-24" />
        ) : comments.length === 0 ? (
          <EmptyState
            icon={MessageSquare}
            title={filter === "OPEN" ? "No open comments" : "No resolved comments"}
            description={canComment ? "Start a discussion about this section below." : undefined}
          />
        ) : (
          comments.map((comment) => (
            <div key={comment.id} className="rounded-md border border-border p-2.5 text-sm">
              <CommentBody
                comment={comment}
                me={me}
                canManage={canManage}
                onDelete={() => void remove(comment)}
              />
              {comment.status === "RESOLVED" && comment.resolvedBy && (
                <p className="mt-1 text-xs text-muted-foreground">
                  Resolved by {comment.resolvedBy.name}
                </p>
              )}
              {(comment.replies ?? []).map((reply) => (
                <div key={reply.id} className="ml-3 mt-2 border-l-2 border-border pl-2.5">
                  <CommentBody
                    comment={reply}
                    me={me}
                    canManage={canManage}
                    onDelete={() => void remove(reply)}
                  />
                </div>
              ))}
              {canComment && (
                <div className="mt-2 flex items-center gap-2">
                  {comment.status === "OPEN" ? (
                    <>
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-6 px-1.5 text-xs"
                        onClick={() => setReplyTo(replyTo === comment.id ? null : comment.id)}
                      >
                        Reply
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-6 px-1.5 text-xs"
                        onClick={() => void setStatus(comment, "RESOLVED")}
                      >
                        <Check /> Resolve
                      </Button>
                    </>
                  ) : (
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-6 px-1.5 text-xs"
                      onClick={() => void setStatus(comment, "OPEN")}
                    >
                      <RotateCcw /> Reopen
                    </Button>
                  )}
                </div>
              )}
              {replyTo === comment.id && canComment && (
                <div className="mt-2">
                  <Composer
                    projectId={projectId}
                    base={base}
                    members={members}
                    me={me}
                    parentId={comment.id}
                    placeholder="Reply…"
                    onPosted={() => {
                      setReplyTo(null);
                      load();
                    }}
                  />
                </div>
              )}
            </div>
          ))
        )}
      </div>

      {canComment && (
        <div className="border-t border-border pt-2">
          <Composer
            projectId={projectId}
            base={base}
            members={members}
            me={me}
            placeholder="Comment on this section… use @ to mention"
            onPosted={load}
          />
        </div>
      )}
    </div>
  );
}

function CommentBody({
  comment,
  me,
  canManage,
  onDelete,
}: {
  comment: CommentView;
  me: UserRef | null;
  canManage: boolean;
  onDelete: () => void;
}) {
  const canDelete = canManage || comment.author.id === me?.id;
  return (
    <div>
      <div className="flex items-baseline justify-between gap-2">
        <p className="text-xs">
          <span className="font-medium">{comment.author.name}</span>{" "}
          <span className="text-muted-foreground">
            {new Date(comment.createdAt).toLocaleString()}
          </span>
        </p>
        {canDelete && (
          <button
            type="button"
            onClick={onDelete}
            className="text-muted-foreground hover:text-destructive"
            title="Delete comment"
          >
            <Trash2 className="h-3.5 w-3.5" />
          </button>
        )}
      </div>
      {comment.quotedText && (
        <blockquote className="mt-1 border-l-2 border-border pl-2 text-xs italic text-muted-foreground">
          {comment.quotedText}
        </blockquote>
      )}
      <p className="mt-1 whitespace-pre-line">{comment.body}</p>
    </div>
  );
}

function Composer({
  projectId: _projectId,
  base,
  members,
  me,
  parentId,
  placeholder,
  onPosted,
}: {
  projectId: string;
  base: string;
  members: MemberRef[];
  me: UserRef | null;
  parentId?: string;
  placeholder: string;
  onPosted: () => void;
}) {
  const [body, setBody] = useState("");
  const [mentions, setMentions] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [mentionOpen, setMentionOpen] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  const mentionable = members.filter((m) => m.status === "ACTIVE" && m.user.id !== me?.id);

  function addMention(member: MemberRef) {
    setMentions((prev) => new Set(prev).add(member.user.id));
    setBody((prev) => `${prev}${prev.endsWith(" ") || prev === "" ? "" : " "}@${member.user.name} `);
    setMentionOpen(false);
    textareaRef.current?.focus();
  }

  async function post() {
    if (!body.trim()) return;
    setBusy(true);
    try {
      await apiPost(base, {
        body: body.trim(),
        parentId,
        mentions: [...mentions],
      });
      setBody("");
      setMentions(new Set());
      onPosted();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Failed to post the comment");
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
      />
      <div className="flex items-center justify-between">
        <Popover open={mentionOpen} onOpenChange={setMentionOpen}>
          <PopoverTrigger asChild>
            <Button variant="ghost" size="sm" className="h-7 px-2 text-xs" type="button">
              <AtSign /> Mention
            </Button>
          </PopoverTrigger>
          <PopoverContent className="w-56 p-1.5">
            {mentionable.length === 0 ? (
              <p className="px-2 py-1 text-xs text-muted-foreground">No other members</p>
            ) : (
              mentionable.map((member) => (
                <button
                  key={member.user.id}
                  type="button"
                  className="block w-full rounded px-2 py-1.5 text-left text-sm hover:bg-muted"
                  onClick={() => addMention(member)}
                >
                  {member.user.name}
                  {mentions.has(member.user.id) && (
                    <Badge variant="secondary" className="ml-2">
                      mentioned
                    </Badge>
                  )}
                </button>
              ))
            )}
          </PopoverContent>
        </Popover>
        <Button size="sm" className="h-7" disabled={busy || !body.trim()} onClick={() => void post()}>
          <Send /> {parentId ? "Reply" : "Comment"}
        </Button>
      </div>
    </div>
  );
}
