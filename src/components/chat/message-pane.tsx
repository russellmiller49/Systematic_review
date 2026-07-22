"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { MessagesSquare, X } from "lucide-react";
import { toast } from "sonner";
import { api, apiDelete, apiPatch, apiPost, ApiError } from "@/lib/api";
import { mentionsToPlainText } from "@/lib/chat/mentions";
import { Button } from "@/components/ui/button";
import { EmptyState, Skeleton } from "@/components/ui/misc";
import type { MemberRef } from "@/components/manuscript/types";
import { Composer } from "./composer";
import { MessageItem } from "./message-item";
import type { ChannelView, MessagesResponse, MessageView } from "./types";
import { channelLabel } from "./types";

const POLL_MS = 4_000; // the poll IS delivery — faster than the 10s AI panels

export function MessagePane({
  projectId,
  channel,
  meId,
  members,
  canAssign,
  canManage,
  focusMessageId,
  onActivity,
}: {
  projectId: string;
  channel: ChannelView;
  meId: string | null;
  members: MemberRef[];
  canAssign: boolean;
  canManage: boolean;
  focusMessageId: string | null;
  onActivity: () => void; // refresh unread badges after we mark read
}) {
  const base = `/api/projects/${projectId}/chat/channels/${channel.id}/messages`;
  const [messages, setMessages] = useState<Map<string, MessageView> | null>(null);
  const [thread, setThread] = useState<MessageView | null>(null);
  const [editing, setEditing] = useState<MessageView | null>(null);
  const [editBody, setEditBody] = useState("");
  const cursorRef = useRef<string | null>(null);
  const inFlightRef = useRef(false);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const stickToBottomRef = useRef(true);

  const mergeMessages = useCallback((incoming: MessageView[]) => {
    setMessages((prev) => {
      const next = new Map(prev ?? []);
      for (const message of incoming) {
        next.set(message.id, message);
        const at = new Date(message.updatedAt).getTime();
        const cursor = cursorRef.current ? new Date(cursorRef.current).getTime() : 0;
        if (at > cursor) cursorRef.current = message.updatedAt;
      }
      return next;
    });
  }, []);

  const markRead = useCallback(() => {
    apiPost(`/api/projects/${projectId}/chat/channels/${channel.id}/read`, {
      at: new Date().toISOString(),
    })
      .then(onActivity)
      .catch(() => undefined);
  }, [projectId, channel.id, onActivity]);

  // Initial load per channel.
  useEffect(() => {
    setMessages(null);
    setThread(null);
    setEditing(null);
    cursorRef.current = null;
    stickToBottomRef.current = true;
    api<MessagesResponse>(`${base}?limit=50`)
      .then((res) => {
        mergeMessages(res.messages);
        markRead();
      })
      .catch((err) => {
        setMessages(new Map());
        toast.error(err instanceof ApiError ? err.message : "Failed to load messages");
      });
  }, [base, mergeMessages, markRead]);

  // Incremental poll (visible only, in-flight guard, focus refetch).
  useEffect(() => {
    const tick = async () => {
      if (inFlightRef.current || document.visibilityState !== "visible") return;
      inFlightRef.current = true;
      try {
        const after = cursorRef.current ?? new Date().toISOString();
        const res = await api<MessagesResponse>(`${base}?after=${encodeURIComponent(after)}`);
        if (res.messages.length > 0) {
          mergeMessages(res.messages);
          markRead();
        }
      } catch {
        // Silent background failure (results-table convention).
      } finally {
        inFlightRef.current = false;
      }
    };
    const timer = window.setInterval(tick, POLL_MS);
    const onFocus = () => void tick();
    window.addEventListener("focus", onFocus);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("focus", onFocus);
    };
  }, [base, mergeMessages, markRead]);

  const roots = useMemo(() => {
    if (!messages) return null;
    return [...messages.values()]
      .filter((m) => m.parentId === null)
      .sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());
  }, [messages]);

  const threadReplies = useMemo(() => {
    if (!messages || !thread) return [];
    return [...messages.values()]
      .filter((m) => m.parentId === thread.id)
      .sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());
  }, [messages, thread]);

  // Autoscroll to bottom when new messages arrive (unless the user scrolled up).
  useEffect(() => {
    const el = scrollRef.current;
    if (el && stickToBottomRef.current) el.scrollTop = el.scrollHeight;
  }, [roots?.length]);

  // Deep link: scroll the focused message into view once loaded.
  useEffect(() => {
    if (!focusMessageId || !roots) return;
    const target = document.getElementById(`msg-${focusMessageId}`);
    if (target) {
      target.scrollIntoView({ block: "center" });
      target.classList.add("bg-accent/60");
      const timeout = window.setTimeout(() => target.classList.remove("bg-accent/60"), 2500);
      return () => window.clearTimeout(timeout);
    }
  }, [focusMessageId, roots]);

  // Load full thread when opened (poll keeps it fresh afterwards).
  useEffect(() => {
    if (!thread) return;
    api<MessagesResponse>(`${base}?parentId=${thread.id}`)
      .then((res) => mergeMessages(res.messages))
      .catch(() => undefined);
  }, [thread, base, mergeMessages]);

  async function removeMessage(message: MessageView) {
    if (!window.confirm("Delete this message?")) return;
    try {
      await apiDelete(`/api/projects/${projectId}/chat/messages/${message.id}`);
      const res = await api<MessagesResponse>(
        `${base}?after=${encodeURIComponent(cursorRef.current ?? new Date(0).toISOString())}`,
      );
      mergeMessages(res.messages);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Failed to delete the message");
    }
  }

  async function saveEdit() {
    if (!editing) return;
    try {
      const updated = await apiPatch<MessageView>(
        `/api/projects/${projectId}/chat/messages/${editing.id}`,
        { body: editBody },
      );
      mergeMessages([updated]);
      setEditing(null);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Failed to edit the message");
    }
  }

  async function completeTask(taskId: string) {
    try {
      await apiPost(`/api/projects/${projectId}/chat/assignments/${taskId}/complete`);
      toast.success("Marked done");
      const res = await api<MessagesResponse>(
        `${base}?after=${encodeURIComponent(cursorRef.current ?? new Date(0).toISOString())}`,
      );
      mergeMessages(res.messages);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Failed to mark the task done");
    }
  }

  const dayOf = (iso: string) => new Date(iso).toLocaleDateString();

  return (
    <div className="flex h-full min-h-0">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <div className="border-b border-border pb-2">
          <p className="text-sm font-semibold">
            {channel.kind === "DIRECT" ? "" : "#"}
            {channelLabel(channel, meId)}
            {channel.archivedAt && (
              <span className="ml-2 text-xs font-normal text-muted-foreground">(archived)</span>
            )}
          </p>
        </div>

        <div
          ref={scrollRef}
          className="min-h-0 flex-1 overflow-y-auto py-2"
          onScroll={(e) => {
            const el = e.currentTarget;
            stickToBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
          }}
        >
          {roots === null ? (
            <Skeleton className="h-40" />
          ) : roots.length === 0 ? (
            <EmptyState
              icon={MessagesSquare}
              title="No messages yet"
              description="Say hello — the whole project team can read this channel."
            />
          ) : (
            roots.map((message, i) => (
              <div key={message.id} id={`msg-${message.id}`} className="rounded-md transition-colors">
                {(i === 0 || dayOf(roots[i - 1]!.createdAt) !== dayOf(message.createdAt)) && (
                  <div className="my-2 flex items-center gap-2 text-xs text-muted-foreground">
                    <span className="h-px flex-1 bg-border" />
                    {dayOf(message.createdAt)}
                    <span className="h-px flex-1 bg-border" />
                  </div>
                )}
                {editing?.id === message.id ? (
                  <div className="space-y-1.5 px-2 py-1.5">
                    <textarea
                      className="w-full rounded-md border border-input bg-background px-2 py-1.5 text-sm"
                      rows={2}
                      value={editBody}
                      onChange={(e) => setEditBody(e.target.value)}
                    />
                    <div className="flex gap-1.5">
                      <Button size="sm" className="h-6 text-xs" onClick={() => void saveEdit()}>
                        Save
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        className="h-6 text-xs"
                        onClick={() => setEditing(null)}
                      >
                        Cancel
                      </Button>
                    </div>
                  </div>
                ) : (
                  <MessageItem
                    message={message}
                    meId={meId}
                    canManage={canManage}
                    onOpenThread={setThread}
                    onEdit={(m) => {
                      setEditing(m);
                      setEditBody(m.body ?? "");
                    }}
                    onDelete={(m) => void removeMessage(m)}
                    onCompleteTask={(taskId) => void completeTask(taskId)}
                  />
                )}
              </div>
            ))
          )}
        </div>

        {!channel.archivedAt && (
          <div className="border-t border-border pt-2">
            <Composer
              projectId={projectId}
              channelId={channel.id}
              members={members}
              meId={meId}
              canAssign={canAssign}
              placeholder={`Message ${channel.kind === "DIRECT" ? channelLabel(channel, meId) : `#${channelLabel(channel, meId)}`}`}
              onPosted={(message) => {
                mergeMessages([message]);
                stickToBottomRef.current = true;
              }}
            />
          </div>
        )}
      </div>

      {thread && (
        <div className="ml-3 flex w-72 shrink-0 flex-col border-l border-border pl-3">
          <div className="flex items-center justify-between border-b border-border pb-2">
            <p className="text-sm font-medium">Thread</p>
            <button
              type="button"
              className="rounded p-1 text-muted-foreground hover:bg-muted"
              onClick={() => setThread(null)}
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto py-2">
            {messages?.get(thread.id) && (
              <MessageItem
                message={messages.get(thread.id)!}
                meId={meId}
                canManage={canManage}
                onEdit={(m) => {
                  setEditing(m);
                  setEditBody(m.body ?? "");
                }}
                onDelete={(m) => void removeMessage(m)}
                onCompleteTask={(taskId) => void completeTask(taskId)}
                isThreadChild
              />
            )}
            <div className="ml-2 border-l-2 border-border pl-2">
              {threadReplies.map((reply) => (
                <MessageItem
                  key={reply.id}
                  message={reply}
                  meId={meId}
                  canManage={canManage}
                  onEdit={(m) => {
                    setEditing(m);
                    setEditBody(mentionsToPlainText(m.body ?? ""));
                  }}
                  onDelete={(m) => void removeMessage(m)}
                  onCompleteTask={(taskId) => void completeTask(taskId)}
                  isThreadChild
                />
              ))}
            </div>
          </div>
          {!channel.archivedAt && (
            <div className="border-t border-border pt-2">
              <Composer
                projectId={projectId}
                channelId={channel.id}
                parentId={thread.id}
                members={members}
                meId={meId}
                canAssign={false}
                placeholder="Reply in thread…"
                onPosted={(message) => mergeMessages([message])}
              />
            </div>
          )}
        </div>
      )}
    </div>
  );
}
