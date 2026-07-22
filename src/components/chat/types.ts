// Shapes returned by the chat API routes — only the fields this UI consumes.

export type ChannelKind = "GENERAL" | "TOPIC" | "DIRECT";

export interface ChannelView {
  id: string;
  kind: ChannelKind;
  name: string | null;
  archivedAt: string | null;
  lastMessageAt: string | null;
  participants: { id: string; name: string }[];
}

export interface AssignmentTaskRef {
  id: string;
  assigneeId: string;
  status: "PENDING" | "COMPLETED" | "VOIDED";
  dueAt: string | null;
  completedAt: string | null;
  assignee: { id: string; name: string };
}

export interface MessageView {
  id: string;
  channelId: string;
  parentId: string | null;
  kind: "MESSAGE" | "ASSIGNMENT";
  body: string | null; // null = deleted tombstone
  mentions: string[];
  replyCount: number;
  editedAt: string | null;
  deleted: boolean;
  createdAt: string;
  updatedAt: string;
  author: { id: string; name: string };
  assignmentTasks: AssignmentTaskRef[];
}

export interface MessagesResponse {
  messages: MessageView[];
  mode: "page" | "incremental" | "thread";
}

export interface UnreadResponse {
  total: number;
  channels: { channelId: string; unread: number }[];
}

export interface AssignmentListItem {
  id: string;
  status: "PENDING" | "COMPLETED" | "VOIDED";
  dueAt: string | null;
  completedAt: string | null;
  assignee: { id: string; name: string };
  createdAt: string;
  message: {
    id: string;
    channelId: string;
    body: string | null;
    author: { id: string; name: string };
    createdAt: string;
  };
}

export function channelLabel(channel: ChannelView, meId: string | null): string {
  if (channel.kind === "GENERAL") return "general";
  if (channel.kind === "TOPIC") return channel.name ?? "topic";
  const others = channel.participants.filter((p) => p.id !== meId);
  return others.length > 0 ? others.map((p) => p.name).join(", ") : "Just you";
}
