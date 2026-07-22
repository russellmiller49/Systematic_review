import type { Prisma } from "@prisma/client";
import { z } from "zod";
import { prisma, type Tx } from "@/server/db";
import type { Ctx } from "@/server/auth/session";

// In-app notification substrate shared by chat, manuscript comments/assignments, and any
// future feature that needs to reach a specific user.
//
// Design decision (amends docs/01 §16 "audit events are the future event source"):
// services emit DIRECTLY, inside the SAME $transaction as the domain mutation, so a
// notification can never exist without its triggering row — the same atomicity guarantee
// as the audit rule, with none of the recipient-resolution machinery an audit-derived
// feed would need. Emit itself is not audited: a notification is a derived delivery
// artifact of an action that is either audited itself (e.g. assignments) or deliberately
// unaudited (e.g. chat messages).

export const NotificationTypes = {
  CHAT_MENTION: "chat.mention",
  CHAT_DM: "chat.dm",
  CHAT_REPLY: "chat.reply",
  CHAT_ASSIGNMENT: "chat.assignment",
  MANUSCRIPT_COMMENT_MENTION: "manuscript.comment.mention",
  MANUSCRIPT_COMMENT_REPLY: "manuscript.comment.reply",
  MANUSCRIPT_SECTION_ASSIGNED: "manuscript.section.assigned",
} as const;

export type NotificationType = (typeof NotificationTypes)[keyof typeof NotificationTypes];

export interface EmitInput {
  userIds: string[];
  projectId: string;
  type: NotificationType;
  actorId: string;
  // Entity ids + a short human snippet (≤ ~200 chars); consumed by the bell UI and
  // notificationHref(). Keep it JSON-safe.
  payload: Record<string, unknown>;
}

// INTERNAL emit API — call from inside another service's $transaction, after that service
// has already authorized the actor. Dedupes recipients and never notifies the actor.
// Returns the number of rows created.
export async function emit(tx: Tx, input: EmitInput): Promise<number> {
  const recipients = [...new Set(input.userIds)].filter((id) => id && id !== input.actorId);
  if (recipients.length === 0) return 0;
  // Round-trip strips undefineds/Dates into JSON-safe values (same trick as audit.record).
  const payload = JSON.parse(JSON.stringify(input.payload)) as Prisma.InputJsonObject;
  const result = await tx.notification.createMany({
    data: recipients.map((userId) => ({
      userId,
      projectId: input.projectId,
      type: input.type,
      actorId: input.actorId,
      payload,
    })),
  });
  return result.count;
}

// --- Self-scoped reads/mutations (ctx.userId only — an inbox is per-user, so no project
// --- permission check is needed; rows for other users are invisible by construction).

const notificationSelect = {
  id: true,
  projectId: true,
  type: true,
  payload: true,
  readAt: true,
  createdAt: true,
  actor: { select: { id: true, name: true } },
  project: { select: { id: true, title: true } },
} satisfies Prisma.NotificationSelect;

// GET query params arrive as strings; "unread=true"/"unread=1" mean true, anything else false.
const boolFromQuery = z
  .string()
  .optional()
  .transform((v) => v === "true" || v === "1");

export const listNotificationsSchema = z.object({
  unread: boolFromQuery,
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(50).default(20),
});
export type ListNotificationsInput = z.infer<typeof listNotificationsSchema>;

export async function listNotifications(ctx: Ctx, input: ListNotificationsInput) {
  const rows = await prisma.notification.findMany({
    where: { userId: ctx.userId, ...(input.unread ? { readAt: null } : {}) },
    select: notificationSelect,
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: input.limit + 1,
    ...(input.cursor ? { cursor: { id: input.cursor }, skip: 1 } : {}),
  });
  const hasMore = rows.length > input.limit;
  const notifications = hasMore ? rows.slice(0, input.limit) : rows;
  const last = notifications[notifications.length - 1];
  return { notifications, nextCursor: hasMore && last ? last.id : null };
}

export async function unreadCount(ctx: Ctx): Promise<{ count: number }> {
  const count = await prisma.notification.count({
    where: { userId: ctx.userId, readAt: null },
  });
  return { count };
}

export const markReadSchema = z.object({
  ids: z.array(z.string().min(1)).min(1).max(100),
});
export type MarkReadInput = z.infer<typeof markReadSchema>;

export async function markRead(ctx: Ctx, input: MarkReadInput): Promise<{ updated: number }> {
  const result = await prisma.notification.updateMany({
    where: { userId: ctx.userId, id: { in: input.ids }, readAt: null },
    data: { readAt: new Date() },
  });
  return { updated: result.count };
}

export const markAllReadSchema = z.object({
  projectId: z.string().optional(),
});
export type MarkAllReadInput = z.infer<typeof markAllReadSchema>;

export async function markAllRead(
  ctx: Ctx,
  input: MarkAllReadInput,
): Promise<{ updated: number }> {
  const result = await prisma.notification.updateMany({
    where: {
      userId: ctx.userId,
      readAt: null,
      ...(input.projectId ? { projectId: input.projectId } : {}),
    },
    data: { readAt: new Date() },
  });
  return { updated: result.count };
}
