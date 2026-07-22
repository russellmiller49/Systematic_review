// Notifications substrate: emit is transaction-scoped and self-notification-free; all
// reads/mutations are strictly self-scoped (an inbox is per-user).
import { beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/server/db";
import * as notifications from "@/server/services/notifications";
import { NotificationTypes } from "@/server/services/notifications";
import { resetDb } from "../db-utils";
import { createProjectWithTeam } from "../factories";

const ctx = (userId: string) => ({ userId });

describe("notifications service", () => {
  beforeAll(async () => {
    await resetDb();
  });

  it("emit creates one row per recipient, dedupes, and never notifies the actor", async () => {
    const { owner, reviewer1, reviewer2, project } = await createProjectWithTeam();

    const created = await prisma.$transaction((tx) =>
      notifications.emit(tx, {
        userIds: [reviewer1.id, reviewer1.id, reviewer2.id, owner.id],
        projectId: project.id,
        type: NotificationTypes.MANUSCRIPT_SECTION_ASSIGNED,
        actorId: owner.id,
        payload: { sectionId: "sec-1", sectionTitle: "Methods", snippet: "Please draft this." },
      }),
    );
    expect(created).toBe(2); // reviewer1 deduped, owner (actor) excluded

    const rows = await prisma.notification.findMany({ where: { projectId: project.id } });
    expect(rows.map((r) => r.userId).sort()).toEqual([reviewer1.id, reviewer2.id].sort());
    expect(rows.every((r) => r.actorId === owner.id && r.readAt === null)).toBe(true);
    expect(rows[0]!.payload).toMatchObject({ sectionId: "sec-1" });
  });

  it("emit with only the actor as recipient is a no-op", async () => {
    const { owner, project } = await createProjectWithTeam();
    const created = await prisma.$transaction((tx) =>
      notifications.emit(tx, {
        userIds: [owner.id],
        projectId: project.id,
        type: NotificationTypes.CHAT_MENTION,
        actorId: owner.id,
        payload: {},
      }),
    );
    expect(created).toBe(0);
  });

  it("emit aborts with its enclosing transaction", async () => {
    const { owner, reviewer1, project } = await createProjectWithTeam();
    await expect(
      prisma.$transaction(async (tx) => {
        await notifications.emit(tx, {
          userIds: [reviewer1.id],
          projectId: project.id,
          type: NotificationTypes.CHAT_MENTION,
          actorId: owner.id,
          payload: { snippet: "doomed" },
        });
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    const count = await prisma.notification.count({ where: { projectId: project.id } });
    expect(count).toBe(0);
  });

  it("list is self-scoped, supports the unread filter, and paginates by cursor", async () => {
    const { owner, reviewer1, reviewer2, project } = await createProjectWithTeam();
    for (let i = 0; i < 3; i++) {
      await prisma.$transaction((tx) =>
        notifications.emit(tx, {
          userIds: [reviewer1.id],
          projectId: project.id,
          type: NotificationTypes.CHAT_MENTION,
          actorId: owner.id,
          payload: { snippet: `hello ${i}` },
        }),
      );
    }

    // Self-scoping: reviewer2 sees nothing, reviewer1 sees 3.
    const other = await notifications.listNotifications(ctx(reviewer2.id), {
      unread: false,
      limit: 20,
    });
    expect(other.notifications).toHaveLength(0);

    const page1 = await notifications.listNotifications(ctx(reviewer1.id), {
      unread: false,
      limit: 2,
    });
    expect(page1.notifications).toHaveLength(2);
    expect(page1.nextCursor).not.toBeNull();
    expect(page1.notifications[0]!.actor).toMatchObject({ id: owner.id });
    expect(page1.notifications[0]!.project).toMatchObject({ id: project.id });

    const page2 = await notifications.listNotifications(ctx(reviewer1.id), {
      unread: false,
      limit: 2,
      cursor: page1.nextCursor!,
    });
    expect(page2.notifications).toHaveLength(1);
    expect(page2.nextCursor).toBeNull();

    const ids = new Set(
      [...page1.notifications, ...page2.notifications].map((n) => n.id),
    );
    expect(ids.size).toBe(3);

    // Unread filter narrows once one is read.
    await notifications.markRead(ctx(reviewer1.id), {
      ids: [page1.notifications[0]!.id],
    });
    const unreadOnly = await notifications.listNotifications(ctx(reviewer1.id), {
      unread: true,
      limit: 20,
    });
    expect(unreadOnly.notifications).toHaveLength(2);
  });

  it("markRead ignores other users' rows; unreadCount and markAllRead are per-user", async () => {
    const { owner, reviewer1, reviewer2, org, project } = await createProjectWithTeam();
    const emitTo = (userId: string, projectId: string) =>
      prisma.$transaction((tx) =>
        notifications.emit(tx, {
          userIds: [userId],
          projectId,
          type: NotificationTypes.CHAT_DM,
          actorId: owner.id,
          payload: { snippet: "hi" },
        }),
      );

    await emitTo(reviewer1.id, project.id);
    await emitTo(reviewer2.id, project.id);
    const r1Row = await prisma.notification.findFirstOrThrow({
      where: { userId: reviewer1.id, projectId: project.id },
    });

    // reviewer2 cannot mark reviewer1's notification read.
    const foreign = await notifications.markRead(ctx(reviewer2.id), { ids: [r1Row.id] });
    expect(foreign.updated).toBe(0);
    const stillUnread = await prisma.notification.findUniqueOrThrow({ where: { id: r1Row.id } });
    expect(stillUnread.readAt).toBeNull();

    // markAllRead with projectId only clears that project's rows.
    const project2 = await prisma.project.create({
      data: {
        orgId: org.id,
        title: "Second project",
        reviewType: "SYSTEMATIC_REVIEW",
        createdById: owner.id,
      },
    });
    await emitTo(reviewer1.id, project2.id);
    expect((await notifications.unreadCount(ctx(reviewer1.id))).count).toBe(2);

    const scoped = await notifications.markAllRead(ctx(reviewer1.id), { projectId: project.id });
    expect(scoped.updated).toBe(1);
    expect((await notifications.unreadCount(ctx(reviewer1.id))).count).toBe(1);

    const all = await notifications.markAllRead(ctx(reviewer1.id), {});
    expect(all.updated).toBe(1);
    expect((await notifications.unreadCount(ctx(reviewer1.id))).count).toBe(0);

    // reviewer2's row untouched by reviewer1's markAllRead.
    expect((await notifications.unreadCount(ctx(reviewer2.id))).count).toBe(1);
  });
});
