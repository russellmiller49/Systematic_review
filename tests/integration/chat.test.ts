// Team chat: lazy #general, topic/DM lifecycle + privacy, threads, mentions,
// assignments, read state + unread math, and the audit-policy deviation (no audit rows
// for plain message post/edit).
import { beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/server/db";
import { AppError } from "@/server/errors";
import * as chat from "@/server/services/chat";
import { insertMention } from "@/lib/chat/mentions";
import { resetDb } from "../db-utils";
import { createProjectWithTeam } from "../factories";

const ctx = (userId: string) => ({ userId });

async function expectAppError(promise: Promise<unknown>, code: string) {
  try {
    await promise;
    expect.fail(`expected AppError(${code}) but call succeeded`);
  } catch (err) {
    if (!(err instanceof AppError)) throw err;
    expect(err.code).toBe(code);
  }
}

describe("chat service", () => {
  beforeAll(async () => {
    await resetDb();
  });

  it("lazily creates exactly one #general (audited); topic channels are manage-gated", async () => {
    const { owner, reviewer1, project } = await createProjectWithTeam();
    const [a, b] = await Promise.all([
      chat.listChannels(ctx(owner.id), project.id),
      chat.listChannels(ctx(reviewer1.id), project.id),
    ]);
    expect(a.filter((c) => c.kind === "GENERAL")).toHaveLength(1);
    expect(b.filter((c) => c.kind === "GENERAL")).toHaveLength(1);
    expect(
      await prisma.chatChannel.count({ where: { projectId: project.id, kind: "GENERAL" } }),
    ).toBe(1);
    await prisma.auditEvent.findFirstOrThrow({
      where: { projectId: project.id, action: "chat.channel.created" },
    });

    await expectAppError(
      chat.createTopicChannel(ctx(reviewer1.id), project.id, { name: "sneaky" }),
      "FORBIDDEN",
    );
    const topic = await chat.createTopicChannel(ctx(owner.id), project.id, {
      name: "screening-questions",
    });
    await expectAppError(
      chat.createTopicChannel(ctx(owner.id), project.id, { name: "Screening-Questions" }),
      "CONFLICT",
    );

    // Archive blocks posting.
    await chat.archiveTopicChannel(ctx(owner.id), project.id, topic.id);
    await expectAppError(
      chat.postMessage(ctx(owner.id), project.id, topic.id, { body: "too late" }),
      "INVALID_STATE",
    );
  });

  it("DMs dedupe by participant set and stay invisible to non-participants", async () => {
    const { owner, reviewer1, reviewer2, adjudicator, project } = await createProjectWithTeam();
    const dm1 = await chat.openDirectChannel(ctx(owner.id), project.id, {
      participantIds: [reviewer1.id, reviewer2.id],
    });
    // Same set, different order/initiator → same channel.
    const dm2 = await chat.openDirectChannel(ctx(reviewer2.id), project.id, {
      participantIds: [owner.id, reviewer1.id],
    });
    expect(dm2.id).toBe(dm1.id);
    // Superset → different channel.
    const dm3 = await chat.openDirectChannel(ctx(owner.id), project.id, {
      participantIds: [reviewer1.id, reviewer2.id, adjudicator.id],
    });
    expect(dm3.id).not.toBe(dm1.id);

    await chat.postMessage(ctx(owner.id), project.id, dm1.id, { body: "private note" });

    // Non-participant: DM invisible in list, unreadable, unpostable (NOT_FOUND, not 403).
    const adjChannels = await chat.listChannels(ctx(adjudicator.id), project.id);
    expect(adjChannels.some((c) => c.id === dm1.id)).toBe(false);
    await expectAppError(
      chat.listMessages(ctx(adjudicator.id), project.id, dm1.id, { limit: 50 }),
      "NOT_FOUND",
    );
    await expectAppError(
      chat.postMessage(ctx(adjudicator.id), project.id, dm1.id, { body: "hi" }),
      "NOT_FOUND",
    );

    // DM co-participant got a CHAT_DM notification.
    await prisma.notification.findFirstOrThrow({
      where: { userId: reviewer1.id, type: "chat.dm" },
    });

    // Non-member participant rejected.
    await expectAppError(
      chat.openDirectChannel(ctx(owner.id), project.id, { participantIds: ["stranger"] }),
      "NOT_FOUND",
    );
  });

  it("messages: post/edit/delete rules, threads, incremental cursor, NO audit for post/edit", async () => {
    const { owner, reviewer1, reviewer2, project } = await createProjectWithTeam();
    const channels = await chat.listChannels(ctx(owner.id), project.id);
    const general = channels.find((c) => c.kind === "GENERAL")!;

    const root = await chat.postMessage(ctx(owner.id), project.id, general.id, {
      body: "Welcome to the project channel!",
    });
    const reply = await chat.postMessage(ctx(reviewer1.id), project.id, general.id, {
      body: "Thanks — question about batch 2 later.",
      parentId: root.id,
    });
    // Reply bumps replyCount; parent author notified.
    const rootRow = await prisma.chatMessage.findUniqueOrThrow({ where: { id: root.id } });
    expect(rootRow.replyCount).toBe(1);
    await prisma.notification.findFirstOrThrow({
      where: { userId: owner.id, type: "chat.reply" },
    });
    // Reply-to-reply rejected.
    await expectAppError(
      chat.postMessage(ctx(reviewer2.id), project.id, general.id, {
        body: "nested",
        parentId: reply.id,
      }),
      "VALIDATION",
    );

    // Edit: author-only; newly-added mentions notified.
    await expectAppError(
      chat.editMessage(ctx(reviewer1.id), project.id, root.id, { body: "hijack" }),
      "FORBIDDEN",
    );
    await chat.editMessage(ctx(owner.id), project.id, root.id, {
      body: insertMention("Welcome! Ping", "Ravi Reviewer", reviewer1.id),
    });
    await prisma.notification.findFirstOrThrow({
      where: { userId: reviewer1.id, type: "chat.mention" },
    });

    // Incremental cursor returns edited + new rows.
    const beforeCursor = new Date(Date.now() - 60_000);
    const incremental = await chat.listMessages(ctx(reviewer2.id), project.id, general.id, {
      after: new Date(Date.now() - 1),
      limit: 100,
    });
    expect(incremental.mode).toBe("incremental");
    // Overlap window (5s) means recent rows appear even with a "now" cursor.
    expect(incremental.messages.length).toBeGreaterThanOrEqual(2);
    const paged = await chat.listMessages(ctx(reviewer2.id), project.id, general.id, {
      before: new Date(),
      limit: 50,
    });
    expect(paged.messages.some((m) => m.id === root.id)).toBe(true);
    expect(beforeCursor.getTime()).toBeLessThan(Date.now());

    // Moderator delete tombstones + audits with snippet; reviewer cannot delete others'.
    await expectAppError(
      chat.deleteMessage(ctx(reviewer2.id), project.id, root.id),
      "FORBIDDEN",
    );
    await chat.deleteMessage(ctx(owner.id), project.id, reply.id); // moderator delete
    const deletedRow = await prisma.chatMessage.findUniqueOrThrow({ where: { id: reply.id } });
    expect(deletedRow.deletedAt).not.toBeNull();
    const deleteEvent = await prisma.auditEvent.findFirstOrThrow({
      where: { entityId: reply.id, action: "chat.message.deleted" },
    });
    expect(deleteEvent.metadata).toMatchObject({ byModerator: true });

    // THE POLICY TEST: no audit rows exist for message posts/edits.
    const chatAudits = await prisma.auditEvent.findMany({
      where: { projectId: project.id, action: { startsWith: "chat." } },
      select: { action: true },
    });
    const allowed = new Set([
      "chat.channel.created",
      "chat.channel.archived",
      "chat.message.deleted",
      "chat.assignment.created",
      "chat.assignment.completed",
      "chat.assignment.voided",
    ]);
    for (const event of chatAudits) expect(allowed.has(event.action)).toBe(true);
  });

  it("@channel fan-out and assignment lifecycle (create → complete → void on delete)", async () => {
    const { owner, reviewer1, reviewer2, adjudicator, project } = await createProjectWithTeam();
    const general = (await chat.listChannels(ctx(owner.id), project.id)).find(
      (c) => c.kind === "GENERAL",
    )!;

    // Non-admin cannot create assignments.
    await expectAppError(
      chat.postMessage(ctx(reviewer1.id), project.id, general.id, {
        body: "do things",
        assignment: {},
      }),
      "FORBIDDEN",
    );

    // Whole-team assignment (default) excludes the author; everyone gets ONE notification
    // (assignment wins over @channel mention).
    const assignment = await chat.postMessage(ctx(owner.id), project.id, general.id, {
      body: "@channel please finish your screening queues this week",
      assignment: { dueAt: new Date(Date.now() + 7 * 24 * 3600 * 1000) },
    });
    expect(assignment.kind).toBe("ASSIGNMENT");
    expect(assignment.assignmentTasks).toHaveLength(3);
    for (const userId of [reviewer1.id, reviewer2.id, adjudicator.id]) {
      expect(
        await prisma.notification.count({
          where: { userId, projectId: project.id, type: "chat.assignment" },
        }),
      ).toBe(1);
      expect(
        await prisma.notification.count({
          where: { userId, projectId: project.id, type: "chat.mention" },
        }),
      ).toBe(0);
    }

    // Assignee completes their own task (audited); others cannot.
    const tasks = await chat.listAssignments(ctx(reviewer1.id), project.id, { mine: true });
    expect(tasks).toHaveLength(1);
    await expectAppError(
      chat.completeAssignmentTask(ctx(reviewer2.id), project.id, tasks[0]!.id),
      "FORBIDDEN",
    );
    await chat.completeAssignmentTask(ctx(reviewer1.id), project.id, tasks[0]!.id);
    await prisma.auditEvent.findFirstOrThrow({
      where: { entityId: tasks[0]!.id, action: "chat.assignment.completed" },
    });

    // Admin sees all; deleting the message voids remaining PENDING tasks.
    const all = await chat.listAssignments(ctx(owner.id), project.id, { mine: false });
    expect(all).toHaveLength(3);
    await chat.deleteMessage(ctx(owner.id), project.id, assignment.id);
    const statuses = await prisma.chatAssignmentTask.findMany({
      where: { messageId: assignment.id },
      select: { status: true },
    });
    expect(statuses.map((t) => t.status).sort()).toEqual(["COMPLETED", "VOIDED", "VOIDED"]);
    await prisma.auditEvent.findFirstOrThrow({
      where: { entityId: assignment.id, action: "chat.assignment.voided" },
    });
  });

  it("read state is forward-only and unread math excludes own + deleted messages", async () => {
    const { owner, reviewer1, project } = await createProjectWithTeam();
    const general = (await chat.listChannels(ctx(owner.id), project.id)).find(
      (c) => c.kind === "GENERAL",
    )!;

    await chat.postMessage(ctx(owner.id), project.id, general.id, { body: "one" });
    const two = await chat.postMessage(ctx(owner.id), project.id, general.id, { body: "two" });
    await chat.postMessage(ctx(owner.id), project.id, general.id, { body: "three" });

    // Author sees zero unread (own messages don't count).
    expect((await chat.getUnreadCounts(ctx(owner.id), project.id)).total).toBe(0);
    // Reviewer1 sees 3, then marks read → 0; an older mark cannot move the watermark back.
    expect((await chat.getUnreadCounts(ctx(reviewer1.id), project.id)).total).toBe(3);
    const marked = await chat.markRead(ctx(reviewer1.id), project.id, general.id, {
      at: new Date(),
    });
    expect((await chat.getUnreadCounts(ctx(reviewer1.id), project.id)).total).toBe(0);
    const stale = await chat.markRead(ctx(reviewer1.id), project.id, general.id, {
      at: new Date(Date.now() - 3600_000),
    });
    expect(stale.lastReadAt.getTime()).toBe(marked.lastReadAt.getTime());

    // New message → 1 unread; deleting it → 0.
    const four = await chat.postMessage(ctx(owner.id), project.id, general.id, { body: "four" });
    expect((await chat.getUnreadCounts(ctx(reviewer1.id), project.id)).total).toBe(1);
    await chat.deleteMessage(ctx(owner.id), project.id, four.id);
    expect((await chat.getUnreadCounts(ctx(reviewer1.id), project.id)).total).toBe(0);
    expect(two.id).toBeTruthy();

    // Tenancy: foreign project's channel id → NOT_FOUND.
    const other = await createProjectWithTeam();
    await expectAppError(
      chat.listMessages(ctx(other.owner.id), other.project.id, general.id, { limit: 10 }),
      "NOT_FOUND",
    );
  });
});
