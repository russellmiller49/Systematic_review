"use client";

import { useState } from "react";
import { Archive, Hash, MessageCirclePlus, Plus, Users } from "lucide-react";
import { toast } from "sonner";
import { apiPost, ApiError } from "@/lib/api";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { MemberRef } from "@/components/manuscript/types";
import { channelLabel, type ChannelView } from "./types";

export function ChannelList({
  projectId,
  channels,
  selectedId,
  unreadByChannel,
  meId,
  members,
  canManage,
  onSelect,
  onChanged,
}: {
  projectId: string;
  channels: ChannelView[];
  selectedId: string | null;
  unreadByChannel: Map<string, number>;
  meId: string | null;
  members: MemberRef[];
  canManage: boolean;
  onSelect: (id: string) => void;
  onChanged: () => void;
}) {
  const [topicOpen, setTopicOpen] = useState(false);
  const [topicName, setTopicName] = useState("");
  const [dmOpen, setDmOpen] = useState(false);
  const [dmTargets, setDmTargets] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);

  const general = channels.filter((c) => c.kind === "GENERAL");
  const topics = channels.filter((c) => c.kind === "TOPIC");
  const directs = channels.filter((c) => c.kind === "DIRECT");

  async function createTopic(e: React.FormEvent) {
    e.preventDefault();
    if (!topicName.trim()) return;
    setBusy(true);
    try {
      const channel = await apiPost<{ id: string }>(`/api/projects/${projectId}/chat/channels`, {
        name: topicName.trim(),
      });
      toast.success("Topic channel created");
      setTopicOpen(false);
      setTopicName("");
      onChanged();
      onSelect(channel.id);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Failed to create the channel");
    } finally {
      setBusy(false);
    }
  }

  async function openDm() {
    if (dmTargets.size === 0) return;
    setBusy(true);
    try {
      const channel = await apiPost<{ id: string }>(
        `/api/projects/${projectId}/chat/channels/direct`,
        { participantIds: [...dmTargets] },
      );
      setDmOpen(false);
      setDmTargets(new Set());
      onChanged();
      onSelect(channel.id);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Failed to open the conversation");
    } finally {
      setBusy(false);
    }
  }

  async function archive(channel: ChannelView) {
    if (!window.confirm(`Archive #${channel.name}? It becomes read-only.`)) return;
    try {
      await apiPost(`/api/projects/${projectId}/chat/channels/${channel.id}/archive`);
      toast.success("Channel archived");
      onChanged();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Failed to archive the channel");
    }
  }

  const row = (channel: ChannelView) => {
    const unread = unreadByChannel.get(channel.id) ?? 0;
    return (
      <div key={channel.id} className="group flex items-center">
        <button
          type="button"
          onClick={() => onSelect(channel.id)}
          className={cn(
            "flex min-w-0 flex-1 items-center gap-1.5 rounded-md px-2 py-1.5 text-left text-sm transition-colors",
            selectedId === channel.id
              ? "bg-accent font-medium text-accent-foreground"
              : "text-muted-foreground hover:bg-muted hover:text-foreground",
          )}
        >
          {channel.kind === "DIRECT" ? (
            <Users className="h-3.5 w-3.5 shrink-0" />
          ) : (
            <Hash className="h-3.5 w-3.5 shrink-0" />
          )}
          <span className={cn("truncate", channel.archivedAt && "line-through opacity-60")}>
            {channelLabel(channel, meId)}
          </span>
          {unread > 0 && (
            <span className="ml-auto flex h-4 min-w-4 items-center justify-center rounded-full bg-primary px-1 text-[10px] font-semibold leading-none text-primary-foreground">
              {unread > 99 ? "99+" : unread}
            </span>
          )}
        </button>
        {canManage && channel.kind === "TOPIC" && !channel.archivedAt && (
          <button
            type="button"
            className="hidden rounded p-1 text-muted-foreground hover:bg-muted group-hover:block"
            onClick={() => void archive(channel)}
            title="Archive channel"
          >
            <Archive className="h-3 w-3" />
          </button>
        )}
      </div>
    );
  };

  return (
    <div className="flex h-full min-h-0 flex-col gap-3">
      <div>
        <p className="px-2 pb-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          Channels
        </p>
        {general.map(row)}
        {topics.map(row)}
        {canManage && (
          <Button
            variant="ghost"
            size="sm"
            className="mt-0.5 h-7 w-full justify-start px-2 text-xs text-muted-foreground"
            onClick={() => setTopicOpen(true)}
          >
            <Plus /> New topic
          </Button>
        )}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <p className="px-2 pb-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          Direct messages
        </p>
        {directs.map(row)}
        <Button
          variant="ghost"
          size="sm"
          className="mt-0.5 h-7 w-full justify-start px-2 text-xs text-muted-foreground"
          onClick={() => setDmOpen(true)}
        >
          <MessageCirclePlus /> New message
        </Button>
      </div>

      <Dialog open={topicOpen} onOpenChange={setTopicOpen}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>New topic channel</DialogTitle>
            <DialogDescription>Visible to every active project member.</DialogDescription>
          </DialogHeader>
          <form onSubmit={createTopic} className="space-y-3">
            <div className="space-y-1.5">
              <Label htmlFor="topic-name">Name</Label>
              <Input
                id="topic-name"
                placeholder="screening-questions"
                value={topicName}
                onChange={(e) => setTopicName(e.target.value)}
              />
            </div>
            <DialogFooter>
              <Button type="submit" disabled={busy || !topicName.trim()}>
                <Plus /> Create channel
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <Dialog open={dmOpen} onOpenChange={setDmOpen}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>New direct message</DialogTitle>
            <DialogDescription>
              Pick one or more members — messaging the same group reuses the conversation.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-1.5">
            {members
              .filter((m) => m.status === "ACTIVE" && m.user.id !== meId)
              .map((member) => (
                <label
                  key={member.user.id}
                  className="flex cursor-pointer items-center gap-2 rounded-md border border-border px-2.5 py-2 text-sm hover:bg-muted"
                >
                  <input
                    type="checkbox"
                    className="h-3.5 w-3.5 accent-primary"
                    checked={dmTargets.has(member.user.id)}
                    onChange={(e) =>
                      setDmTargets((prev) => {
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
          <DialogFooter>
            <Button disabled={busy || dmTargets.size === 0} onClick={() => void openDm()}>
              <MessageCirclePlus /> Start conversation
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
