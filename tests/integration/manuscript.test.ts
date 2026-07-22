// Manuscript drafting: auto-init, structure authz, assignment-gated editing, the lock
// protocol (fresh/stale/takeover), optimistic-concurrency saves, version cuts, comments
// with mentions → notifications, cite-map ordering, and DOCX export.
import { beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/server/db";
import { AppError } from "@/server/errors";
import * as manuscript from "@/server/services/manuscript";
import * as references from "@/server/services/references";
import { LOCK_STALE_MS } from "@/lib/manuscript/lock-rules";
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

function doc(text: string, extra: unknown[] = []) {
  return {
    type: "doc",
    content: [
      { type: "paragraph", content: [{ type: "text", text }] },
      ...(extra as object[]),
    ],
  };
}

async function backdateLock(sectionId: string) {
  await prisma.manuscriptSection.update({
    where: { id: sectionId },
    data: { lockHeartbeatAt: new Date(Date.now() - LOCK_STALE_MS - 1000) },
  });
}

describe("manuscript service", () => {
  beforeAll(async () => {
    await resetDb();
  });

  it("auto-inits the manuscript with 8 IMRaD sections exactly once (audited)", async () => {
    const { owner, reviewer1, project } = await createProjectWithTeam();
    const first = await manuscript.getManuscript(ctx(owner.id), project.id);
    expect(first.sections).toHaveLength(8);
    expect(first.sections.map((s) => s.kind)[0]).toBe("TITLE_PAGE");
    await prisma.auditEvent.findFirstOrThrow({
      where: { projectId: project.id, action: "manuscript.created" },
    });

    const second = await manuscript.getManuscript(ctx(reviewer1.id), project.id);
    expect(second.sections).toHaveLength(8); // idempotent
    expect(second.canManage).toBe(false);
    expect(second.canEditAny).toBe(false); // REVIEWER edits only assigned sections
  });

  it("structure ops are manage-gated and audited; reorder validates the id set", async () => {
    const { owner, reviewer1, project } = await createProjectWithTeam();
    await manuscript.getManuscript(ctx(owner.id), project.id);

    await expectAppError(
      manuscript.createSection(ctx(reviewer1.id), project.id, { title: "Sneaky" }),
      "FORBIDDEN",
    );

    const section = await manuscript.createSection(ctx(owner.id), project.id, {
      title: "Limitations",
    });
    expect(section.order).toBe(8);
    await prisma.auditEvent.findFirstOrThrow({
      where: { entityId: section.id, action: "manuscript.section.created" },
    });

    const all = await manuscript.getManuscript(ctx(owner.id), project.id);
    const ids = all.sections.map((s) => s.id);
    await expectAppError(
      manuscript.reorderSections(ctx(owner.id), project.id, { orderedIds: ids.slice(1) }),
      "VALIDATION",
    );
    await manuscript.reorderSections(ctx(owner.id), project.id, {
      orderedIds: [...ids.slice(1), ids[0]!],
    });
    const after = await manuscript.getManuscript(ctx(owner.id), project.id);
    expect(after.sections[after.sections.length - 1]!.id).toBe(ids[0]);

    await manuscript.updateSection(ctx(owner.id), project.id, section.id, { title: "Renamed" });
    await manuscript.deleteSection(ctx(owner.id), project.id, section.id);
    await prisma.auditEvent.findFirstOrThrow({
      where: { entityId: section.id, action: "manuscript.section.deleted" },
    });
  });

  it("assignment grants section-scoped editing and emits a notification", async () => {
    const { owner, reviewer1, project } = await createProjectWithTeam();
    const ms = await manuscript.getManuscript(ctx(owner.id), project.id);
    const results = ms.sections.find((s) => s.kind === "RESULTS")!;
    const methods = ms.sections.find((s) => s.kind === "METHODS")!;

    await manuscript.assignSection(ctx(owner.id), project.id, results.id, {
      assigneeId: reviewer1.id,
    });
    const notification = await prisma.notification.findFirstOrThrow({
      where: { userId: reviewer1.id, type: "manuscript.section.assigned" },
    });
    expect(notification.payload).toMatchObject({ sectionId: results.id });

    // Assignee can lock + save THEIR section…
    const lock = await manuscript.acquireLock(ctx(reviewer1.id), project.id, results.id, {});
    expect(lock.lock?.userId).toBe(reviewer1.id);
    const saved = await manuscript.saveSectionContent(ctx(reviewer1.id), project.id, results.id, {
      content: doc("Results drafted by the assignee."),
      baseVersion: lock.version,
    });
    expect(saved.version).toBe(lock.version + 1);
    expect(saved.wordCount).toBe(5);

    // …but not other sections.
    await expectAppError(
      manuscript.acquireLock(ctx(reviewer1.id), project.id, methods.id, {}),
      "FORBIDDEN",
    );

    // Assigning a non-member fails.
    await expectAppError(
      manuscript.assignSection(ctx(owner.id), project.id, results.id, {
        assigneeId: "not-a-member",
      }),
      "NOT_FOUND",
    );
  });

  it("locks: fresh conflicts, stale takeover cuts an attributed version, release cuts once", async () => {
    const { owner, adjudicator, project } = await createProjectWithTeam();
    const ms = await manuscript.getManuscript(ctx(owner.id), project.id);
    const intro = ms.sections.find((s) => s.kind === "INTRODUCTION")!;

    // Owner edits + saves (dirty), then goes idle.
    const ownerLock = await manuscript.acquireLock(ctx(owner.id), project.id, intro.id, {});
    await manuscript.saveSectionContent(ctx(owner.id), project.id, intro.id, {
      content: doc("Owner's draft paragraph."),
      baseVersion: ownerLock.version,
    });

    // Fresh lock: adjudicator (has manuscript.edit) cannot steal, even with takeover.
    await expectAppError(
      manuscript.acquireLock(ctx(adjudicator.id), project.id, intro.id, {}),
      "CONFLICT",
    );
    await expectAppError(
      manuscript.acquireLock(ctx(adjudicator.id), project.id, intro.id, { takeover: true }),
      "CONFLICT",
    );

    // Stale without takeover → 409 with stale flag; with takeover → transfer + version
    // attributed to the previous holder + audit.
    await backdateLock(intro.id);
    await expectAppError(
      manuscript.acquireLock(ctx(adjudicator.id), project.id, intro.id, {}),
      "CONFLICT",
    );
    const taken = await manuscript.acquireLock(ctx(adjudicator.id), project.id, intro.id, {
      takeover: true,
    });
    expect(taken.lock?.userId).toBe(adjudicator.id);
    const takeoverVersion = await prisma.manuscriptSectionVersion.findFirstOrThrow({
      where: { sectionId: intro.id, origin: "TAKEOVER" },
    });
    expect(takeoverVersion.savedById).toBe(owner.id);
    await prisma.auditEvent.findFirstOrThrow({
      where: { entityId: intro.id, action: "manuscript.section.lock.taken_over" },
    });

    // Old holder's release is a no-op that keeps the new holder's lock.
    const noop = await manuscript.releaseLock(ctx(owner.id), project.id, intro.id);
    expect(noop.released).toBe(false);
    const fresh = await prisma.manuscriptSection.findUniqueOrThrow({ where: { id: intro.id } });
    expect(fresh.lockedById).toBe(adjudicator.id);

    // Old holder's heartbeat now conflicts.
    await expectAppError(manuscript.heartbeatLock(ctx(owner.id), project.id, intro.id), "CONFLICT");

    // New holder edits then releases → exactly one LOCK_RELEASE version; releasing again
    // cuts nothing (capturedVersion idempotence).
    await manuscript.saveSectionContent(ctx(adjudicator.id), project.id, intro.id, {
      content: doc("Adjudicator revision."),
      baseVersion: fresh.version,
    });
    await manuscript.releaseLock(ctx(adjudicator.id), project.id, intro.id);
    const releases = await prisma.manuscriptSectionVersion.count({
      where: { sectionId: intro.id, origin: "LOCK_RELEASE" },
    });
    expect(releases).toBe(1);
    await manuscript.acquireLock(ctx(adjudicator.id), project.id, intro.id, {});
    await manuscript.releaseLock(ctx(adjudicator.id), project.id, intro.id);
    expect(
      await prisma.manuscriptSectionVersion.count({
        where: { sectionId: intro.id, origin: "LOCK_RELEASE" },
      }),
    ).toBe(1);
  });

  it("content saves enforce lock + baseVersion; APPROVED refuses edits; bad docs rejected", async () => {
    const { owner, project } = await createProjectWithTeam();
    const ms = await manuscript.getManuscript(ctx(owner.id), project.id);
    const abstract = ms.sections.find((s) => s.kind === "ABSTRACT")!;

    // No lock → CONFLICT.
    await expectAppError(
      manuscript.saveSectionContent(ctx(owner.id), project.id, abstract.id, {
        content: doc("No lock"),
        baseVersion: 0,
      }),
      "CONFLICT",
    );

    const lock = await manuscript.acquireLock(ctx(owner.id), project.id, abstract.id, {});
    await expectAppError(
      manuscript.saveSectionContent(ctx(owner.id), project.id, abstract.id, {
        content: doc("Wrong base"),
        baseVersion: lock.version + 5,
      }),
      "CONFLICT",
    );
    await expectAppError(
      manuscript.saveSectionContent(ctx(owner.id), project.id, abstract.id, {
        content: { type: "paragraph" },
        baseVersion: lock.version,
      }),
      "VALIDATION",
    );
    await manuscript.saveSectionContent(ctx(owner.id), project.id, abstract.id, {
      content: doc("Valid abstract."),
      baseVersion: lock.version,
    });

    // Approve (manage) → further locking/editing refused; assignee cannot approve.
    await manuscript.setSectionStatus(ctx(owner.id), project.id, abstract.id, {
      status: "APPROVED",
    });
    await expectAppError(
      manuscript.acquireLock(ctx(owner.id), project.id, abstract.id, {}),
      "INVALID_STATE",
    );
    const statusEvents = await prisma.auditEvent.count({
      where: { entityId: abstract.id, action: "manuscript.section.status_changed" },
    });
    expect(statusEvents).toBe(1);
  });

  it("explicit versions + restore (with pre-image) work under the lock", async () => {
    const { owner, project } = await createProjectWithTeam();
    const ms = await manuscript.getManuscript(ctx(owner.id), project.id);
    const discussion = ms.sections.find((s) => s.kind === "DISCUSSION")!;

    const lock = await manuscript.acquireLock(ctx(owner.id), project.id, discussion.id, {});
    await manuscript.saveSectionContent(ctx(owner.id), project.id, discussion.id, {
      content: doc("First draft."),
      baseVersion: lock.version,
    });
    const v1 = await manuscript.createVersion(ctx(owner.id), project.id, discussion.id, {
      note: "First complete draft",
    });
    expect(v1.versionNumber).toBe(1);

    await manuscript.saveSectionContent(ctx(owner.id), project.id, discussion.id, {
      content: doc("Second draft, quite different."),
      baseVersion: lock.version + 1,
    });
    const restored = await manuscript.restoreVersion(
      ctx(owner.id),
      project.id,
      discussion.id,
      v1.id,
    );
    expect(restored.wordCount).toBe(2); // "First draft."
    const origins = (
      await prisma.manuscriptSectionVersion.findMany({
        where: { sectionId: discussion.id },
        orderBy: { versionNumber: "asc" },
      })
    ).map((v) => v.origin);
    expect(origins).toEqual(["EXPLICIT", "RESTORE"]);
    await prisma.auditEvent.findFirstOrThrow({
      where: { entityId: discussion.id, action: "manuscript.section.version.restored" },
    });
  });

  it("comments: one-level threads, validated mentions, notifications, resolve + delete rules", async () => {
    const { owner, reviewer1, reviewer2, project } = await createProjectWithTeam();
    const ms = await manuscript.getManuscript(ctx(owner.id), project.id);
    const methods = ms.sections.find((s) => s.kind === "METHODS")!;

    await expectAppError(
      manuscript.createComment(ctx(owner.id), project.id, methods.id, {
        body: "Mentions a stranger",
        mentions: ["stranger-id"],
      }),
      "VALIDATION",
    );

    const root = await manuscript.createComment(ctx(reviewer1.id), project.id, methods.id, {
      body: "Should we cite the LIBERATE trial here? @Olivia",
      mentions: [owner.id],
      quotedText: "search strategy",
    });
    const mentionNotification = await prisma.notification.findFirstOrThrow({
      where: { userId: owner.id, type: "manuscript.comment.mention" },
    });
    expect(mentionNotification.payload).toMatchObject({ commentId: root.id });

    const reply = await manuscript.createComment(ctx(owner.id), project.id, methods.id, {
      body: "Yes — add it to the flow paragraph.",
      parentId: root.id,
    });
    await prisma.notification.findFirstOrThrow({
      where: { userId: reviewer1.id, type: "manuscript.comment.reply" },
    });
    await expectAppError(
      manuscript.createComment(ctx(reviewer2.id), project.id, methods.id, {
        body: "Reply to a reply",
        parentId: reply.id,
      }),
      "VALIDATION",
    );

    await manuscript.setCommentStatus(ctx(owner.id), project.id, methods.id, root.id, {
      status: "RESOLVED",
    });
    await prisma.auditEvent.findFirstOrThrow({
      where: { entityId: root.id, action: "manuscript.comment.resolved" },
    });

    // Author cannot delete a thread with replies; reviewer2 cannot delete others' comments.
    await expectAppError(
      manuscript.deleteComment(ctx(reviewer1.id), project.id, methods.id, root.id),
      "INVALID_STATE",
    );
    await expectAppError(
      manuscript.deleteComment(ctx(reviewer2.id), project.id, methods.id, reply.id),
      "FORBIDDEN",
    );
    // Manager cascade-deletes the thread.
    await manuscript.deleteComment(ctx(owner.id), project.id, methods.id, root.id);
    expect(
      await prisma.manuscriptComment.count({ where: { sectionId: methods.id } }),
    ).toBe(0);
  });

  it("cite-map orders references by first use across sections; DOCX exports (audited)", async () => {
    const { owner, project } = await createProjectWithTeam();
    const ms = await manuscript.getManuscript(ctx(owner.id), project.id);
    const intro = ms.sections.find((s) => s.kind === "INTRODUCTION")!;
    const discussion = ms.sections.find((s) => s.kind === "DISCUSSION")!;

    const refA = await references.createReference(ctx(owner.id), project.id, {
      csl: {
        type: "article-journal",
        title: "Alpha trial",
        author: [{ family: "Alpha", given: "A" }],
        issued: { "date-parts": [[2018]] },
      },
    });
    const refB = await references.createReference(ctx(owner.id), project.id, {
      csl: {
        type: "article-journal",
        title: "Beta trial",
        author: [{ family: "Beta", given: "B" }],
        issued: { "date-parts": [[2019]] },
      },
    });

    const cite = (id: string) => ({ type: "citation", attrs: { referenceIds: [id] } });
    let lock = await manuscript.acquireLock(ctx(owner.id), project.id, intro.id, {});
    await manuscript.saveSectionContent(ctx(owner.id), project.id, intro.id, {
      content: {
        type: "doc",
        content: [
          { type: "paragraph", content: [{ type: "text", text: "Beta first " }, cite(refB.id)] },
        ],
      },
      baseVersion: lock.version,
    });
    lock = await manuscript.acquireLock(ctx(owner.id), project.id, discussion.id, {});
    await manuscript.saveSectionContent(ctx(owner.id), project.id, discussion.id, {
      content: {
        type: "doc",
        content: [
          { type: "paragraph", content: [{ type: "text", text: "Alpha later " }, cite(refA.id)] },
        ],
      },
      baseVersion: lock.version,
    });

    const citeMap = await manuscript.getCiteMap(ctx(owner.id), project.id);
    expect(citeMap.orderedReferenceIds).toEqual([refB.id, refA.id]);
    expect(citeMap.markers[refB.id]).toBe("1");
    expect(citeMap.markers[refA.id]).toBe("2");
    expect(citeMap.bibliography.map((e) => e.referenceId)).toEqual([refB.id, refA.id]);

    const out = await manuscript.exportDocx(ctx(owner.id), project.id);
    // DOCX files are zip archives → PK magic.
    expect(out.buffer[0]).toBe(0x50);
    expect(out.buffer[1]).toBe(0x4b);
    expect(out.filename).toContain("-manuscript.docx");
    await prisma.auditEvent.findFirstOrThrow({
      where: { projectId: project.id, action: "manuscript.exported" },
    });

    // Tenancy: a foreign project cannot reach this section.
    const other = await createProjectWithTeam();
    await expectAppError(
      manuscript.getSection(ctx(other.owner.id), other.project.id, intro.id),
      "NOT_FOUND",
    );
  });
});
