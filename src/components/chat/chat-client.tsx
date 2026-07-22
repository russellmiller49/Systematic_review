"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useSearchParams } from "next/navigation";
import { toast } from "sonner";
import { api, ApiError } from "@/lib/api";
import { PageHeader } from "@/components/layout/page-header";
import { Skeleton } from "@/components/ui/misc";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import type { MemberRef } from "@/components/manuscript/types";
import { AssignmentsTab } from "./assignments-tab";
import { ChannelList } from "./channel-list";
import { MessagePane } from "./message-pane";
import type { ChannelView, UnreadResponse } from "./types";

const UNREAD_POLL_MS = 30_000;

export function ChatClient({ projectId }: { projectId: string }) {
  const searchParams = useSearchParams();
  const [channels, setChannels] = useState<ChannelView[] | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(searchParams.get("channel"));
  const [focusMessageId, setFocusMessageId] = useState<string | null>(searchParams.get("message"));
  const [me, setMe] = useState<{ id: string; name: string } | null>(null);
  const [members, setMembers] = useState<MemberRef[]>([]);
  const [capabilities, setCapabilities] = useState<string[]>([]);
  const [unread, setUnread] = useState<UnreadResponse>({ total: 0, channels: [] });
  const [tab, setTab] = useState("chat");

  const loadChannels = useCallback(async () => {
    try {
      const list = await api<ChannelView[]>(`/api/projects/${projectId}/chat/channels`);
      setChannels(list);
      setSelectedId((prev) => prev ?? list[0]?.id ?? null);
    } catch (err) {
      setChannels([]);
      toast.error(err instanceof ApiError ? err.message : "Failed to load chat channels");
    }
  }, [projectId]);

  const loadUnread = useCallback(() => {
    api<UnreadResponse>(`/api/projects/${projectId}/chat/unread`)
      .then(setUnread)
      .catch(() => undefined);
  }, [projectId]);

  useEffect(() => {
    loadChannels();
    loadUnread();
    api<{ user: { id: string; name: string } }>(`/api/me`)
      .then((res) => setMe({ id: res.user.id, name: res.user.name }))
      .catch(() => setMe(null));
    api<MemberRef[]>(`/api/projects/${projectId}/members`)
      .then(setMembers)
      .catch(() => setMembers([]));
    api<{ capabilities: string[] }>(`/api/projects/${projectId}`)
      .then((p) => setCapabilities(p.capabilities))
      .catch(() => setCapabilities([]));
  }, [projectId, loadChannels, loadUnread]);

  // Channel list + unread badges refresh (30s visible + focus — app convention).
  useEffect(() => {
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") {
        loadChannels();
        loadUnread();
      }
    }, UNREAD_POLL_MS);
    const onFocus = () => {
      loadChannels();
      loadUnread();
    };
    window.addEventListener("focus", onFocus);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("focus", onFocus);
    };
  }, [loadChannels, loadUnread]);

  const unreadByChannel = useMemo(
    () => new Map(unread.channels.map((c) => [c.channelId, c.unread])),
    [unread],
  );
  const selected = channels?.find((c) => c.id === selectedId) ?? null;
  const canManage = capabilities.includes("chat.manage");
  const canAssign = capabilities.includes("chat.assign");

  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col">
      <PageHeader
        title="Team chat"
        description="Coordinate the review — ask questions, share instructions, and hand out assignments without leaving the workspace."
      />
      <Tabs value={tab} onValueChange={setTab}>
        <TabsList>
          <TabsTrigger value="chat">Chat</TabsTrigger>
          <TabsTrigger value="assignments">Assignments</TabsTrigger>
        </TabsList>
        <TabsContent value="chat" className="pt-3">
          <div className="grid min-h-[70vh] gap-4 lg:grid-cols-[13rem_minmax(0,1fr)]">
            <div className="rounded-lg border border-border bg-card p-2.5">
              {channels === null ? (
                <Skeleton className="h-64" />
              ) : (
                <ChannelList
                  projectId={projectId}
                  channels={channels}
                  selectedId={selectedId}
                  unreadByChannel={unreadByChannel}
                  meId={me?.id ?? null}
                  members={members}
                  canManage={canManage}
                  onSelect={(id) => {
                    setSelectedId(id);
                    setFocusMessageId(null);
                  }}
                  onChanged={loadChannels}
                />
              )}
            </div>
            <div className="rounded-lg border border-border bg-card p-3">
              {selected ? (
                <MessagePane
                  key={selected.id}
                  projectId={projectId}
                  channel={selected}
                  meId={me?.id ?? null}
                  members={members}
                  canAssign={canAssign}
                  canManage={canManage}
                  focusMessageId={focusMessageId}
                  onActivity={loadUnread}
                />
              ) : (
                <p className="text-sm text-muted-foreground">Select a channel to start.</p>
              )}
            </div>
          </div>
        </TabsContent>
        <TabsContent value="assignments" className="pt-3">
          <AssignmentsTab
            projectId={projectId}
            meId={me?.id ?? null}
            canAssign={canAssign}
            onOpenChannel={(channelId, messageId) => {
              setSelectedId(channelId);
              setFocusMessageId(messageId);
              setTab("chat");
            }}
          />
        </TabsContent>
      </Tabs>
    </div>
  );
}
