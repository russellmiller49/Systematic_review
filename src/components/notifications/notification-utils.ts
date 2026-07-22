// Pure helpers for rendering notifications (unit-testable, no React).

export interface NotificationView {
  id: string;
  projectId: string;
  type: string;
  payload: Record<string, unknown>;
  readAt: string | null;
  createdAt: string;
  actor: { id: string; name: string } | null;
  project: { id: string; title: string };
}

const LABELS: Record<string, string> = {
  "chat.mention": "mentioned you",
  "chat.dm": "sent you a direct message",
  "chat.reply": "replied to your message",
  "chat.assignment": "assigned you a task",
  "manuscript.comment.mention": "mentioned you in a manuscript comment",
  "manuscript.comment.reply": "replied to your manuscript comment",
  "manuscript.section.assigned": "assigned you a manuscript section",
};

export function notificationLabel(n: Pick<NotificationView, "type">): string {
  return LABELS[n.type] ?? "sent you a notification";
}

// Maps a notification to its in-app destination. Unknown types land on the project
// dashboard so a stale client never renders a dead link.
export function notificationHref(
  n: Pick<NotificationView, "type" | "projectId" | "payload">,
): string {
  const base = `/projects/${n.projectId}`;
  const p = n.payload as { channelId?: unknown; messageId?: unknown; sectionId?: unknown };
  if (n.type.startsWith("chat.")) {
    const params = new URLSearchParams();
    if (typeof p.channelId === "string") params.set("channel", p.channelId);
    if (typeof p.messageId === "string") params.set("message", p.messageId);
    const qs = params.toString();
    return `${base}/chat${qs ? `?${qs}` : ""}`;
  }
  if (n.type.startsWith("manuscript.")) {
    const params = new URLSearchParams();
    if (typeof p.sectionId === "string") params.set("section", p.sectionId);
    const qs = params.toString();
    return `${base}/manuscript${qs ? `?${qs}` : ""}`;
  }
  return base;
}

export function notificationSnippet(n: Pick<NotificationView, "payload">): string | null {
  const snippet = (n.payload as { snippet?: unknown }).snippet;
  return typeof snippet === "string" && snippet.trim() ? snippet : null;
}

// Compact relative time ("just now", "5m", "3h", "2d", then a locale date).
export function timeAgo(iso: string, now: Date = new Date()): string {
  const then = new Date(iso).getTime();
  if (!Number.isFinite(then)) return "";
  const seconds = Math.max(0, Math.floor((now.getTime() - then) / 1000));
  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d`;
  return new Date(iso).toLocaleDateString();
}
