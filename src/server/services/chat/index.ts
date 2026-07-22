// Team chat — project channels (#general + topics), DMs (1:1 and small groups via a
// participant-set dedupe key), one-level threads, @mentions, and assignment messages
// with per-assignee done-tracking. Delivery is client polling (user-approved; no
// realtime transport exists in this stack).
//
// AUDIT POLICY (deliberate deviation, docs/06 + actions.ts): message post/edit and
// read-state upserts are NOT audited; structural events (channel create/archive,
// assignment lifecycle, deletes) are, in the same transaction as the mutation.

import { z } from "zod";
import type { ChatChannel, ChatMessage, Prisma } from "@prisma/client";
import { prisma, type Tx } from "@/server/db";
import { conflict, forbidden, invalidState, notFound, validationError } from "@/server/errors";
import type { Ctx } from "@/server/auth/session";
import { can, requirePermission } from "@/server/permissions";
import * as audit from "@/server/services/audit";
import { AuditActions } from "@/server/services/audit";
import * as notifications from "@/server/services/notifications";
import { NotificationTypes } from "@/server/services/notifications";
import { mentionsToPlainText, parseMentions } from "@/lib/chat/mentions";

const EPOCH = new Date(0);
const CURSOR_OVERLAP_MS = 5_000; // updatedAt cursor overlap window (client merges by id)
const SNIPPET_MAX = 160;

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

export const createTopicChannelSchema = z.object({
  name: z.string().trim().min(2).max(60),
});

export const openDirectChannelSchema = z.object({
  participantIds: z.array(z.string().min(1)).min(1).max(7), // others; ≤8 total with the caller
});

export const listMessagesSchema = z.object({
  after: z.coerce.date().optional(), // updatedAt incremental cursor (all messages)
  before: z.coerce.date().optional(), // createdAt history pagination (roots only)
  parentId: z.string().optional(), // thread fetch
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

export const postMessageSchema = z.object({
  body: z.string().trim().min(1).max(8000),
  parentId: z.string().optional(),
  assignment: z
    .object({
      assigneeIds: z.array(z.string().min(1)).min(1).max(50).optional(), // omitted ⇒ whole team
      dueAt: z.coerce.date().optional(),
    })
    .optional(),
});

export const editMessageSchema = z.object({
  body: z.string().trim().min(1).max(8000),
});

export const markReadSchema = z.object({
  at: z.coerce.date(),
});

export const listAssignmentsSchema = z.object({
  mine: z
    .string()
    .optional()
    .transform((v) => v === "true" || v === "1"),
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const userRef = { select: { id: true, name: true } } satisfies { select: Prisma.UserSelect };

function directDedupeKey(userIds: string[]): string {
  return "dm:" + [...new Set(userIds)].sort().join(":");
}

async function activeMemberIds(projectId: string, tx: Tx = prisma): Promise<Set<string>> {
  const members = await tx.projectMember.findMany({
    where: { projectId, status: "ACTIVE" },
    select: { userId: true },
  });
  return new Set(members.map((m) => m.userId));
}

// Tenant-scoped channel load + DIRECT visibility: non-participants get notFound so a
// DM's existence never leaks.
async function getVisibleChannel(
  tx: Tx,
  projectId: string,
  channelId: string,
  userId: string,
): Promise<ChatChannel> {
  const channel = await tx.chatChannel.findFirst({
    where: { id: channelId, projectId },
    include: { participants: { select: { userId: true } } },
  });
  if (!channel) throw notFound("Channel");
  if (channel.kind === "DIRECT" && !channel.participants.some((p) => p.userId === userId)) {
    throw notFound("Channel");
  }
  return channel;
}

function serializeMessage(
  message: ChatMessage & {
    author: { id: string; name: string };
    assignmentTasks?: {
      id: string;
      assigneeId: string;
      status: string;
      dueAt: Date | null;
      completedAt: Date | null;
      assignee: { id: string; name: string };
    }[];
  },
) {
  const deleted = message.deletedAt !== null;
  return {
    id: message.id,
    channelId: message.channelId,
    parentId: message.parentId,
    kind: message.kind,
    body: deleted ? null : message.body,
    mentions: deleted ? [] : message.mentions,
    replyCount: message.replyCount,
    editedAt: message.editedAt,
    deleted,
    createdAt: message.createdAt,
    updatedAt: message.updatedAt,
    author: message.author,
    assignmentTasks: message.assignmentTasks ?? [],
  };
}

const messageInclude = {
  author: userRef,
  assignmentTasks: {
    select: {
      id: true,
      assigneeId: true,
      status: true,
      dueAt: true,
      completedAt: true,
      assignee: userRef,
    },
    orderBy: { createdAt: "asc" as const },
  },
};

// ---------------------------------------------------------------------------
// Channels
// ---------------------------------------------------------------------------

// Lazily materializes #general (race-safe via the [projectId, dedupeKey] unique).
async function ensureGeneralChannel(ctx: Ctx, projectId: string): Promise<ChatChannel> {
  const existing = await prisma.chatChannel.findFirst({
    where: { projectId, kind: "GENERAL" },
  });
  if (existing) return existing;
  try {
    return await prisma.$transaction(async (tx) => {
      const channel = await tx.chatChannel.create({
        data: { projectId, kind: "GENERAL", dedupeKey: "general", createdById: ctx.userId },
      });
      await audit.record(tx, {
        projectId,
        userId: ctx.userId,
        entityType: "ChatChannel",
        entityId: channel.id,
        action: AuditActions.CHAT_CHANNEL_CREATED,
        newValue: { kind: "GENERAL" },
      });
      return channel;
    });
  } catch (err) {
    if ((err as { code?: string }).code === "P2002") {
      return prisma.chatChannel.findFirstOrThrow({ where: { projectId, kind: "GENERAL" } });
    }
    throw err;
  }
}

export async function listChannels(ctx: Ctx, projectId: string) {
  await requirePermission(ctx, projectId, "chat.participate");
  await ensureGeneralChannel(ctx, projectId);
  const channels = await prisma.chatChannel.findMany({
    where: {
      projectId,
      OR: [
        { kind: { in: ["GENERAL", "TOPIC"] } },
        { kind: "DIRECT", participants: { some: { userId: ctx.userId } } },
      ],
    },
    include: { participants: { include: { user: userRef } } },
  });
  const rank = { GENERAL: 0, TOPIC: 1, DIRECT: 2 } as const;
  channels.sort((a, b) => {
    if (rank[a.kind] !== rank[b.kind]) return rank[a.kind] - rank[b.kind];
    if (a.kind === "TOPIC") return (a.name ?? "").localeCompare(b.name ?? "");
    return (b.lastMessageAt?.getTime() ?? 0) - (a.lastMessageAt?.getTime() ?? 0);
  });
  return channels.map((c) => ({
    id: c.id,
    kind: c.kind,
    name: c.name,
    archivedAt: c.archivedAt,
    lastMessageAt: c.lastMessageAt,
    participants:
      c.kind === "DIRECT" ? c.participants.map((p) => ({ id: p.user.id, name: p.user.name })) : [],
  }));
}

export async function createTopicChannel(
  ctx: Ctx,
  projectId: string,
  input: z.infer<typeof createTopicChannelSchema>,
) {
  await requirePermission(ctx, projectId, "chat.manage");
  const existing = await prisma.chatChannel.findFirst({
    where: { projectId, kind: "TOPIC", name: { equals: input.name, mode: "insensitive" } },
  });
  if (existing) throw conflict("A topic channel with this name already exists");
  return prisma.$transaction(async (tx) => {
    const channel = await tx.chatChannel.create({
      data: { projectId, kind: "TOPIC", name: input.name, createdById: ctx.userId },
    });
    await audit.record(tx, {
      projectId,
      userId: ctx.userId,
      entityType: "ChatChannel",
      entityId: channel.id,
      action: AuditActions.CHAT_CHANNEL_CREATED,
      newValue: { kind: "TOPIC", name: channel.name },
    });
    return channel;
  });
}

export async function archiveTopicChannel(ctx: Ctx, projectId: string, channelId: string) {
  await requirePermission(ctx, projectId, "chat.manage");
  const channel = await prisma.chatChannel.findFirst({ where: { id: channelId, projectId } });
  if (!channel) throw notFound("Channel");
  if (channel.kind !== "TOPIC") throw invalidState("Only topic channels can be archived");
  if (channel.archivedAt) return channel;
  return prisma.$transaction(async (tx) => {
    const archived = await tx.chatChannel.update({
      where: { id: channel.id },
      data: { archivedAt: new Date() },
    });
    await audit.record(tx, {
      projectId,
      userId: ctx.userId,
      entityType: "ChatChannel",
      entityId: channel.id,
      action: AuditActions.CHAT_CHANNEL_ARCHIVED,
      previousValue: { name: channel.name },
    });
    return archived;
  });
}

// Create-or-return the DM for a participant set (order-independent).
export async function openDirectChannel(
  ctx: Ctx,
  projectId: string,
  input: z.infer<typeof openDirectChannelSchema>,
) {
  await requirePermission(ctx, projectId, "chat.participate");
  const participantIds = [...new Set([ctx.userId, ...input.participantIds])];
  if (participantIds.length < 2) throw validationError("Pick at least one other member");
  const members = await activeMemberIds(projectId);
  for (const userId of participantIds) {
    if (!members.has(userId)) throw notFound("Member");
  }
  const dedupeKey = directDedupeKey(participantIds);

  const existing = await prisma.chatChannel.findUnique({
    where: { projectId_dedupeKey: { projectId, dedupeKey } },
  });
  if (existing) return existing;
  try {
    return await prisma.$transaction(async (tx) => {
      const channel = await tx.chatChannel.create({
        data: {
          projectId,
          kind: "DIRECT",
          dedupeKey,
          createdById: ctx.userId,
          participants: { create: participantIds.map((userId) => ({ userId })) },
        },
      });
      await audit.record(tx, {
        projectId,
        userId: ctx.userId,
        entityType: "ChatChannel",
        entityId: channel.id,
        action: AuditActions.CHAT_CHANNEL_CREATED,
        newValue: { kind: "DIRECT", participantIds },
      });
      return channel;
    });
  } catch (err) {
    if ((err as { code?: string }).code === "P2002") {
      return prisma.chatChannel.findUniqueOrThrow({
        where: { projectId_dedupeKey: { projectId, dedupeKey } },
      });
    }
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Messages
// ---------------------------------------------------------------------------

export async function listMessages(
  ctx: Ctx,
  projectId: string,
  channelId: string,
  query: z.infer<typeof listMessagesSchema>,
) {
  await requirePermission(ctx, projectId, "chat.participate");
  const channel = await getVisibleChannel(prisma, projectId, channelId, ctx.userId);

  if (query.parentId) {
    const messages = await prisma.chatMessage.findMany({
      where: { channelId: channel.id, OR: [{ id: query.parentId }, { parentId: query.parentId }] },
      include: messageInclude,
      orderBy: { createdAt: "asc" },
    });
    return { messages: messages.map(serializeMessage), mode: "thread" as const };
  }

  if (query.after) {
    // Incremental: everything (roots + replies) touched since the cursor, with an
    // overlap window; the client merges by id, so duplicates are harmless.
    const since = new Date(query.after.getTime() - CURSOR_OVERLAP_MS);
    const messages = await prisma.chatMessage.findMany({
      where: { channelId: channel.id, updatedAt: { gt: since } },
      include: messageInclude,
      orderBy: { updatedAt: "asc" },
      take: 200,
    });
    return { messages: messages.map(serializeMessage), mode: "incremental" as const };
  }

  // Initial/history: newest root messages first (client renders ascending).
  const messages = await prisma.chatMessage.findMany({
    where: {
      channelId: channel.id,
      parentId: null,
      ...(query.before ? { createdAt: { lt: query.before } } : {}),
    },
    include: messageInclude,
    orderBy: { createdAt: "desc" },
    take: query.limit,
  });
  return { messages: messages.map(serializeMessage).reverse(), mode: "page" as const };
}

export async function postMessage(
  ctx: Ctx,
  projectId: string,
  channelId: string,
  input: z.infer<typeof postMessageSchema>,
) {
  const member = await requirePermission(ctx, projectId, "chat.participate");
  const channel = await getVisibleChannel(prisma, projectId, channelId, ctx.userId);
  if (channel.archivedAt) throw invalidState("This channel is archived");

  if (input.assignment) {
    if (!can(member.roles, "chat.assign")) {
      throw forbidden("Only project owners/admins can create assignments");
    }
    if (input.parentId) throw invalidState("Assignments cannot be thread replies");
  }

  let parent: ChatMessage | null = null;
  if (input.parentId) {
    parent = await prisma.chatMessage.findFirst({
      where: { id: input.parentId, channelId: channel.id },
    });
    if (!parent) throw notFound("Message");
    if (parent.parentId !== null) throw validationError("Replies can only target top-level messages");
    if (parent.deletedAt) throw invalidState("That message was deleted");
  }

  const members = await activeMemberIds(projectId);
  const parsed = parseMentions(input.body);
  const mentionIds = parsed.userIds.filter((id) => members.has(id));

  // Assignment fan-out: explicit assignees (validated) or the whole team minus author.
  let assigneeIds: string[] = [];
  if (input.assignment) {
    if (input.assignment.assigneeIds && input.assignment.assigneeIds.length > 0) {
      assigneeIds = [...new Set(input.assignment.assigneeIds)];
      for (const id of assigneeIds) {
        if (!members.has(id)) throw notFound("Member");
      }
    } else {
      assigneeIds = [...members].filter((id) => id !== ctx.userId);
    }
    if (assigneeIds.length === 0) throw invalidState("There is nobody to assign this to");
  }

  const snippet = mentionsToPlainText(input.body).slice(0, SNIPPET_MAX);
  const channelName = channel.kind === "GENERAL" ? "general" : (channel.name ?? "direct message");

  const message = await prisma.$transaction(async (tx) => {
    const created = await tx.chatMessage.create({
      data: {
        channelId: channel.id,
        authorId: ctx.userId,
        parentId: input.parentId ?? null,
        kind: input.assignment ? "ASSIGNMENT" : "MESSAGE",
        body: input.body,
        mentions: mentionIds,
      },
      include: messageInclude,
    });
    if (parent) {
      await tx.chatMessage.update({
        where: { id: parent.id },
        data: { replyCount: { increment: 1 } },
      });
    }
    await tx.chatChannel.update({
      where: { id: channel.id },
      data: { lastMessageAt: created.createdAt },
    });

    if (input.assignment) {
      await tx.chatAssignmentTask.createMany({
        data: assigneeIds.map((assigneeId) => ({
          messageId: created.id,
          projectId,
          assigneeId,
          dueAt: input.assignment!.dueAt ?? null,
        })),
      });
      await audit.record(tx, {
        projectId,
        userId: ctx.userId,
        entityType: "ChatMessage",
        entityId: created.id,
        action: AuditActions.CHAT_ASSIGNMENT_CREATED,
        newValue: { assigneeIds, dueAt: input.assignment.dueAt ?? null, snippet },
      });
    }

    // Notification fan-out, one per recipient, priority: assignment > mention (@channel
    // expands) > DM co-participants > thread reply-to-author.
    const notified = new Set<string>([ctx.userId]);
    const payload = { channelId: channel.id, channelName, messageId: created.id, snippet };
    const emitTo = async (userIds: string[], type: (typeof NotificationTypes)[keyof typeof NotificationTypes]) => {
      const fresh = userIds.filter((id) => !notified.has(id));
      fresh.forEach((id) => notified.add(id));
      if (fresh.length > 0) {
        await notifications.emit(tx, {
          userIds: fresh,
          projectId,
          type,
          actorId: ctx.userId,
          payload,
        });
      }
    };

    await emitTo(assigneeIds, NotificationTypes.CHAT_ASSIGNMENT);
    const mentionTargets = parsed.hasChannelMention && channel.kind !== "DIRECT"
      ? [...members]
      : mentionIds;
    await emitTo(mentionTargets, NotificationTypes.CHAT_MENTION);
    if (channel.kind === "DIRECT") {
      const participants = await tx.chatChannelParticipant.findMany({
        where: { channelId: channel.id },
        select: { userId: true },
      });
      await emitTo(
        participants.map((p) => p.userId),
        NotificationTypes.CHAT_DM,
      );
    }
    if (parent && parent.authorId !== ctx.userId) {
      await emitTo([parent.authorId], NotificationTypes.CHAT_REPLY);
    }

    return created;
  });

  const withTasks = await prisma.chatMessage.findUniqueOrThrow({
    where: { id: message.id },
    include: messageInclude,
  });
  return serializeMessage(withTasks);
}

export async function editMessage(
  ctx: Ctx,
  projectId: string,
  messageId: string,
  input: z.infer<typeof editMessageSchema>,
) {
  await requirePermission(ctx, projectId, "chat.participate");
  const message = await prisma.chatMessage.findFirst({
    where: { id: messageId, channel: { projectId } },
    include: { channel: true },
  });
  if (!message) throw notFound("Message");
  if (message.authorId !== ctx.userId) throw forbidden("You can only edit your own messages");
  if (message.deletedAt) throw invalidState("That message was deleted");

  const members = await activeMemberIds(projectId);
  const mentionIds = parseMentions(input.body).userIds.filter((id) => members.has(id));
  const newlyMentioned = mentionIds.filter((id) => !message.mentions.includes(id));

  const updated = await prisma.$transaction(async (tx) => {
    const result = await tx.chatMessage.update({
      where: { id: message.id },
      data: { body: input.body, mentions: mentionIds, editedAt: new Date() },
      include: messageInclude,
    });
    if (newlyMentioned.length > 0) {
      await notifications.emit(tx, {
        userIds: newlyMentioned,
        projectId,
        type: NotificationTypes.CHAT_MENTION,
        actorId: ctx.userId,
        payload: {
          channelId: message.channelId,
          messageId: message.id,
          snippet: mentionsToPlainText(input.body).slice(0, SNIPPET_MAX),
        },
      });
    }
    return result;
  });
  return serializeMessage(updated);
}

export async function deleteMessage(ctx: Ctx, projectId: string, messageId: string) {
  const member = await requirePermission(ctx, projectId, "chat.participate");
  const message = await prisma.chatMessage.findFirst({
    where: { id: messageId, channel: { projectId } },
  });
  if (!message) throw notFound("Message");
  if (message.deletedAt) return { deleted: true };
  const byModerator = message.authorId !== ctx.userId;
  if (byModerator && !can(member.roles, "chat.manage")) {
    throw forbidden("You can only delete your own messages");
  }

  await prisma.$transaction(async (tx) => {
    await tx.chatMessage.update({
      where: { id: message.id },
      data: { deletedAt: new Date(), deletedById: ctx.userId },
    });
    if (message.parentId) {
      await tx.chatMessage.update({
        where: { id: message.parentId },
        data: { replyCount: { decrement: 1 } },
      });
    }
    const voided = await tx.chatAssignmentTask.updateMany({
      where: { messageId: message.id, status: "PENDING" },
      data: { status: "VOIDED" },
    });
    if (voided.count > 0) {
      await audit.record(tx, {
        projectId,
        userId: ctx.userId,
        entityType: "ChatMessage",
        entityId: message.id,
        action: AuditActions.CHAT_ASSIGNMENT_VOIDED,
        metadata: { voidedTaskCount: voided.count },
      });
    }
    await audit.record(tx, {
      projectId,
      userId: ctx.userId,
      entityType: "ChatMessage",
      entityId: message.id,
      action: AuditActions.CHAT_MESSAGE_DELETED,
      previousValue: { snippet: mentionsToPlainText(message.body).slice(0, 200) },
      metadata: { byModerator },
    });
  });
  return { deleted: true };
}

// ---------------------------------------------------------------------------
// Read state + unread counts
// ---------------------------------------------------------------------------

export async function markRead(
  ctx: Ctx,
  projectId: string,
  channelId: string,
  input: z.infer<typeof markReadSchema>,
) {
  await requirePermission(ctx, projectId, "chat.participate");
  const channel = await getVisibleChannel(prisma, projectId, channelId, ctx.userId);
  const at = new Date(Math.min(input.at.getTime(), Date.now()));
  const existing = await prisma.chatReadState.findUnique({
    where: { channelId_userId: { channelId: channel.id, userId: ctx.userId } },
  });
  if (existing && existing.lastReadAt >= at) return { lastReadAt: existing.lastReadAt };
  const state = await prisma.chatReadState.upsert({
    where: { channelId_userId: { channelId: channel.id, userId: ctx.userId } },
    create: { channelId: channel.id, userId: ctx.userId, lastReadAt: at },
    update: { lastReadAt: at },
  });
  return { lastReadAt: state.lastReadAt };
}

export async function getUnreadCounts(ctx: Ctx, projectId: string) {
  await requirePermission(ctx, projectId, "chat.participate");
  const channels = await prisma.chatChannel.findMany({
    where: {
      projectId,
      OR: [
        { kind: { in: ["GENERAL", "TOPIC"] } },
        { kind: "DIRECT", participants: { some: { userId: ctx.userId } } },
      ],
    },
    select: { id: true },
  });
  if (channels.length === 0) return { total: 0, channels: [] };
  const readStates = await prisma.chatReadState.findMany({
    where: { userId: ctx.userId, channelId: { in: channels.map((c) => c.id) } },
  });
  const lastRead = new Map(readStates.map((s) => [s.channelId, s.lastReadAt]));

  const grouped = await prisma.chatMessage.groupBy({
    by: ["channelId"],
    _count: { _all: true },
    where: {
      deletedAt: null,
      authorId: { not: ctx.userId },
      OR: channels.map((c) => ({
        channelId: c.id,
        createdAt: { gt: lastRead.get(c.id) ?? EPOCH },
      })),
    },
  });
  const perChannel = grouped.map((g) => ({ channelId: g.channelId, unread: g._count._all }));
  return {
    total: perChannel.reduce((sum, c) => sum + c.unread, 0),
    channels: perChannel,
  };
}

// ---------------------------------------------------------------------------
// Assignments
// ---------------------------------------------------------------------------

export async function listAssignments(
  ctx: Ctx,
  projectId: string,
  input: z.infer<typeof listAssignmentsSchema>,
) {
  const member = await requirePermission(ctx, projectId, "chat.participate");
  const mine = input.mine || !can(member.roles, "chat.assign");
  const tasks = await prisma.chatAssignmentTask.findMany({
    where: { projectId, ...(mine ? { assigneeId: ctx.userId } : {}) },
    include: {
      assignee: userRef,
      message: {
        select: {
          id: true,
          channelId: true,
          body: true,
          deletedAt: true,
          createdAt: true,
          author: userRef,
        },
      },
    },
    orderBy: [{ status: "asc" }, { dueAt: { sort: "asc", nulls: "last" } }, { createdAt: "desc" }],
  });
  return tasks.map((task) => ({
    id: task.id,
    status: task.status,
    dueAt: task.dueAt,
    completedAt: task.completedAt,
    assignee: task.assignee,
    createdAt: task.createdAt,
    message: {
      id: task.message.id,
      channelId: task.message.channelId,
      body: task.message.deletedAt ? null : task.message.body,
      author: task.message.author,
      createdAt: task.message.createdAt,
    },
  }));
}

export async function completeAssignmentTask(ctx: Ctx, projectId: string, taskId: string) {
  await requirePermission(ctx, projectId, "chat.participate");
  const task = await prisma.chatAssignmentTask.findFirst({ where: { id: taskId, projectId } });
  if (!task) throw notFound("Assignment");
  if (task.assigneeId !== ctx.userId) {
    throw forbidden("Only the assignee can mark this done");
  }
  if (task.status !== "PENDING") return task;
  return prisma.$transaction(async (tx) => {
    const updated = await tx.chatAssignmentTask.update({
      where: { id: task.id },
      data: { status: "COMPLETED", completedAt: new Date() },
    });
    await audit.record(tx, {
      projectId,
      userId: ctx.userId,
      entityType: "ChatAssignmentTask",
      entityId: task.id,
      action: AuditActions.CHAT_ASSIGNMENT_COMPLETED,
      metadata: { messageId: task.messageId },
    });
    return updated;
  });
}
