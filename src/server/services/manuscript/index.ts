// Manuscript drafting — modular sections with soft locks + versions + comments.
// Follows the exemplar service shape (src/server/services/orgs). Collaboration model
// (user-approved): one editor per section at a time via a heartbeat lock (30s beat /
// 90s stale / takeover when stale), optimistic-concurrency `version` counter on content
// writes (409 on mismatch), durable snapshots cut at session boundaries.
//
// AUDIT POLICY (deliberate deviation, documented in docs/STATUS): per-keystroke autosave
// content saves and lock acquire/heartbeat/release are NOT audited — version cuts, which
// bound every editing session, are the audited record. Takeover IS audited (it overrides
// another user).

import { z } from "zod";
import type { ManuscriptSection, Prisma } from "@prisma/client";
import { prisma, type Tx } from "@/server/db";
import {
  AppError,
  conflict,
  forbidden,
  invalidState,
  notFound,
  validationError,
} from "@/server/errors";
import type { Ctx } from "@/server/auth/session";
import { can, getMembership, requirePermission } from "@/server/permissions";
import * as audit from "@/server/services/audit";
import { AuditActions } from "@/server/services/audit";
import * as notifications from "@/server/services/notifications";
import { NotificationTypes } from "@/server/services/notifications";
import * as references from "@/server/services/references";
import {
  countWords,
  EMPTY_DOC,
  extractDocText,
  collectCitationRefs,
  validateDoc,
} from "@/lib/manuscript/doc-text";
import { isLockStale } from "@/lib/manuscript/lock-rules";
import {
  DEFAULT_SECTIONS,
  hasPicoDefaultSectionStructure,
  PICO_SECTIONS,
} from "./default-sections";

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const sectionKindEnum = z.enum([
  "TITLE_PAGE",
  "ABSTRACT",
  "INTRODUCTION",
  "METHODS",
  "RESULTS",
  "DISCUSSION",
  "CONCLUSION",
  "ACKNOWLEDGMENTS",
  "CUSTOM",
]);

export const updateManuscriptSchema = z.object({
  title: z.string().trim().min(1).max(300).optional(),
  citationStyleId: z.string().trim().min(1).max(100).nullable().optional(),
});

export const createSectionSchema = z.object({
  title: z.string().trim().min(1).max(200),
  kind: sectionKindEnum.optional(),
});

export const updateSectionSchema = z.object({
  title: z.string().trim().min(1).max(200).optional(),
  kind: sectionKindEnum.optional(),
});

export const reorderSectionsSchema = z.object({
  orderedIds: z.array(z.string().min(1)).min(1),
});

export const assignSectionSchema = z.object({
  assigneeId: z.string().nullable(),
});

export const sectionStatusSchema = z.object({
  status: z.enum(["DRAFT", "IN_REVIEW", "APPROVED"]),
});

export const acquireLockSchema = z.object({
  takeover: z.boolean().optional(),
});

export const saveContentSchema = z.object({
  content: z.unknown(), // shape + size asserted via validateDoc in the service
  baseVersion: z.number().int().min(0),
});

export const createVersionSchema = z.object({
  note: z.string().trim().max(500).optional(),
});

export const createCommentSchema = z.object({
  body: z.string().trim().min(1).max(5000),
  parentId: z.string().optional(),
  quotedText: z.string().trim().max(1000).optional(),
  mentions: z.array(z.string().min(1)).max(20).optional(),
});

export const commentStatusSchema = z.object({
  status: z.enum(["OPEN", "RESOLVED"]),
});

export const resetToPicoDefaultsSchema = z.object({
  confirmDataLoss: z.literal(true),
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const userRef = { select: { id: true, name: true } } satisfies { select: Prisma.UserSelect };

interface LockView {
  userId: string;
  name: string;
  acquiredAt: Date | null;
  heartbeatAt: Date | null;
  stale: boolean;
}

function lockView(
  section: ManuscriptSection & { lockedBy: { id: string; name: string } | null },
  now: Date,
): LockView | null {
  if (!section.lockedById || !section.lockedBy) return null;
  return {
    userId: section.lockedById,
    name: section.lockedBy.name,
    acquiredAt: section.lockAcquiredAt,
    heartbeatAt: section.lockHeartbeatAt,
    stale: isLockStale(section.lockHeartbeatAt, now),
  };
}

async function getOrCreateManuscript(ctx: Ctx, projectId: string) {
  const existing = await prisma.manuscript.findUnique({ where: { projectId } });
  if (existing) return existing;
  // PICO sub-projects seed question-specific sections; the general IMRaD sections
  // belong to the parent guideline's manuscript.
  const project = await prisma.project.findUnique({
    where: { id: projectId },
    select: { parentProjectId: true },
  });
  const defaults = project?.parentProjectId ? PICO_SECTIONS : DEFAULT_SECTIONS;
  try {
    return await prisma.$transaction(async (tx) => {
      const manuscript = await tx.manuscript.create({
        data: { projectId, createdById: ctx.userId },
      });
      await tx.manuscriptSection.createMany({
        data: defaults.map((s, order) => ({
          manuscriptId: manuscript.id,
          title: s.title,
          kind: s.kind,
          order,
          content: EMPTY_DOC as Prisma.InputJsonObject,
        })),
      });
      await audit.record(tx, {
        projectId,
        userId: ctx.userId,
        entityType: "Manuscript",
        entityId: manuscript.id,
        action: AuditActions.MANUSCRIPT_CREATED,
        metadata: { sectionCount: defaults.length },
      });
      return manuscript;
    });
  } catch (err) {
    // Race-safe: another request created it between the check and the insert.
    if ((err as { code?: string }).code === "P2002") {
      return prisma.manuscript.findUniqueOrThrow({ where: { projectId } });
    }
    throw err;
  }
}

// Tenant-scoped section load (R9): the section's manuscript must belong to the project.
async function loadSection(tx: Tx, projectId: string, sectionId: string) {
  const section = await tx.manuscriptSection.findFirst({
    where: { id: sectionId, manuscript: { projectId } },
    include: { lockedBy: userRef, assignee: userRef },
  });
  if (!section) throw notFound("Section");
  return section;
}

// Section-scoped edit right: manuscript.edit (any section) OR being the assignee
// (assignment-gated editing, mirroring the REVIEWER screening precedent).
function assertCanEditSection(
  member: { roles: Prisma.ProjectMemberGetPayload<object>["roles"] },
  section: { assigneeId: string | null },
  userId: string,
) {
  if (can(member.roles, "manuscript.edit")) return;
  if (section.assigneeId === userId) return;
  throw forbidden("You can only edit sections assigned to you");
}

function assertNotApproved(section: { status: string }) {
  if (section.status === "APPROVED") {
    throw invalidState("This section is approved — reopen it before editing");
  }
}

// 409 with structured lock details for the client's banner/takeover UX.
function lockedConflict(
  section: ManuscriptSection & { lockedBy: { id: string; name: string } | null },
  stale: boolean,
): AppError {
  return new AppError(
    "CONFLICT",
    stale
      ? `${section.lockedBy?.name ?? "Someone"}'s editing session looks idle — you can take over`
      : `${section.lockedBy?.name ?? "Someone"} is editing this section`,
    { lockedBy: section.lockedBy, heartbeatAt: section.lockHeartbeatAt, stale },
  );
}

// Cut a durable snapshot iff the section has content changes not yet captured.
async function cutVersionIfDirty(
  tx: Tx,
  section: ManuscriptSection,
  origin: "EXPLICIT" | "LOCK_RELEASE" | "TAKEOVER" | "RESTORE",
  savedById: string,
  note?: string | null,
  force = false,
) {
  const latest = await tx.manuscriptSectionVersion.aggregate({
    where: { sectionId: section.id },
    _max: { versionNumber: true, capturedVersion: true },
  });
  const captured = latest._max.capturedVersion ?? -1;
  if (!force && section.version <= captured) return null;
  return tx.manuscriptSectionVersion.create({
    data: {
      sectionId: section.id,
      versionNumber: (latest._max.versionNumber ?? 0) + 1,
      capturedVersion: section.version,
      origin,
      content: section.content as Prisma.InputJsonValue,
      contentText: section.contentText,
      wordCount: section.wordCount,
      note: note ?? null,
      savedById,
    },
  });
}

async function activeMemberIds(projectId: string): Promise<Set<string>> {
  const members = await prisma.projectMember.findMany({
    where: { projectId, status: "ACTIVE" },
    select: { userId: true },
  });
  return new Set(members.map((m) => m.userId));
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

export async function getManuscript(ctx: Ctx, projectId: string) {
  const member = await requirePermission(ctx, projectId, "manuscript.view");
  const manuscript = await getOrCreateManuscript(ctx, projectId);
  const [project, sections] = await Promise.all([
    prisma.project.findUnique({
      where: { id: projectId },
      select: { parentProjectId: true },
    }),
    prisma.manuscriptSection.findMany({
      where: { manuscriptId: manuscript.id },
      include: {
        assignee: userRef,
        lockedBy: userRef,
        _count: { select: { comments: { where: { status: "OPEN", parentId: null } } } },
      },
      orderBy: { order: "asc" },
    }),
  ]);
  if (!project) throw notFound("Project");
  const now = new Date();
  const isPicoSubProject = project.parentProjectId !== null;
  const usesPicoDefaultSections = hasPicoDefaultSectionStructure(sections);
  return {
    id: manuscript.id,
    title: manuscript.title,
    citationStyleId: manuscript.citationStyleId,
    canEditAny: can(member.roles, "manuscript.edit"),
    canManage: can(member.roles, "manuscript.manage"),
    canComment: can(member.roles, "manuscript.comment"),
    isPicoSubProject,
    usesPicoDefaultSections,
    canResetToPicoDefaults:
      isPicoSubProject &&
      member.roles.includes("OWNER") &&
      !usesPicoDefaultSections,
    sections: sections.map((s) => ({
      id: s.id,
      title: s.title,
      kind: s.kind,
      order: s.order,
      status: s.status,
      wordCount: s.wordCount,
      version: s.version,
      updatedAt: s.updatedAt,
      assignee: s.assignee,
      lock: lockView(s, now),
      openCommentCount: s._count.comments,
      canEdit:
        s.status !== "APPROVED" &&
        (can(member.roles, "manuscript.edit") || s.assigneeId === ctx.userId),
    })),
  };
}

export async function getSection(ctx: Ctx, projectId: string, sectionId: string) {
  const member = await requirePermission(ctx, projectId, "manuscript.view");
  const section = await loadSection(prisma, projectId, sectionId);
  return {
    id: section.id,
    title: section.title,
    kind: section.kind,
    status: section.status,
    content: section.content,
    contentText: section.contentText,
    wordCount: section.wordCount,
    version: section.version,
    assignee: section.assignee,
    lock: lockView(section, new Date()),
    canEdit:
      section.status !== "APPROVED" &&
      (can(member.roles, "manuscript.edit") || section.assigneeId === ctx.userId),
  };
}

// ---------------------------------------------------------------------------
// Manuscript settings + structure (manuscript.manage)
// ---------------------------------------------------------------------------

export async function updateManuscript(
  ctx: Ctx,
  projectId: string,
  input: z.infer<typeof updateManuscriptSchema>,
) {
  await requirePermission(ctx, projectId, "manuscript.manage");
  const manuscript = await getOrCreateManuscript(ctx, projectId);
  return prisma.$transaction(async (tx) => {
    const updated = await tx.manuscript.update({
      where: { id: manuscript.id },
      data: {
        ...(input.title !== undefined ? { title: input.title } : {}),
        ...(input.citationStyleId !== undefined ? { citationStyleId: input.citationStyleId } : {}),
      },
    });
    await audit.record(tx, {
      projectId,
      userId: ctx.userId,
      entityType: "Manuscript",
      entityId: manuscript.id,
      action: AuditActions.MANUSCRIPT_UPDATED,
      previousValue: { title: manuscript.title, citationStyleId: manuscript.citationStyleId },
      newValue: { title: updated.title, citationStyleId: updated.citationStyleId },
    });
    return updated;
  });
}

type PicoDefaultsResetTrigger = "PROJECT_CONVERSION" | "EXISTING_SUBPROJECT";

interface PicoDefaultsResetOptions {
  confirmDataLoss: true;
  trigger: PicoDefaultsResetTrigger;
}

// Shared destructive primitive for both conversion and an existing legacy sub-project.
// The caller's OWNER role and the sub-project relationship are re-checked inside the
// transaction. The Manuscript row (title/style) stays intact; only section-scoped data is
// replaced.
export async function resetManuscriptToPicoDefaultsInTransaction(
  ctx: Ctx,
  projectId: string,
  tx: Tx,
  options: PicoDefaultsResetOptions,
) {
  if (options.confirmDataLoss !== true) {
    throw validationError("Explicit confirmation is required before manuscript data is deleted");
  }

  const member = await requirePermission(ctx, projectId, "manuscript.manage", tx);
  if (!member.roles.includes("OWNER")) {
    throw forbidden("Only a project owner can replace the manuscript with PICO defaults");
  }

  // Serialize destructive resets for this project. Locking the manuscript row as well
  // prevents a concurrent structure insert from leaving a sixth section behind.
  await tx.$queryRaw`SELECT id FROM "Project" WHERE id = ${projectId} FOR UPDATE`;
  const project = await tx.project.findUnique({
    where: { id: projectId },
    select: { parentProjectId: true },
  });
  if (!project) throw notFound("Project");
  if (!project.parentProjectId) {
    throw invalidState("Only a PICO sub-project can use the PICO manuscript defaults");
  }

  await tx.$queryRaw`SELECT id FROM "Manuscript" WHERE "projectId" = ${projectId} FOR UPDATE`;
  let manuscript = await tx.manuscript.findUnique({
    where: { projectId },
    include: {
      sections: {
        include: { _count: { select: { comments: true, versions: true } } },
        orderBy: { order: "asc" },
      },
    },
  });

  if (!manuscript) {
    manuscript = await tx.manuscript.create({
      data: { projectId, createdById: ctx.userId },
      include: {
        sections: {
          include: { _count: { select: { comments: true, versions: true } } },
          orderBy: { order: "asc" },
        },
      },
    });
    await audit.record(tx, {
      projectId,
      userId: ctx.userId,
      entityType: "Manuscript",
      entityId: manuscript.id,
      action: AuditActions.MANUSCRIPT_CREATED,
      metadata: { sectionCount: PICO_SECTIONS.length, defaultSet: "PICO" },
    });
  }

  const previousSections = manuscript.sections.map((section) => ({
    id: section.id,
    title: section.title,
    kind: section.kind,
    order: section.order,
    status: section.status,
    wordCount: section.wordCount,
    version: section.version,
    commentCount: section._count?.comments ?? 0,
    versionCount: section._count?.versions ?? 0,
    assigned: section.assigneeId !== null,
    locked: section.lockedById !== null,
  }));
  const sectionIds = previousSections.map((section) => section.id);

  let deletedCommentCount = 0;
  let deletedVersionCount = 0;
  let deletedSectionCount = 0;
  if (sectionIds.length > 0) {
    // Comment threads self-reference, so replies must go before their roots.
    const replies = await tx.manuscriptComment.deleteMany({
      where: { sectionId: { in: sectionIds }, parentId: { not: null } },
    });
    const roots = await tx.manuscriptComment.deleteMany({
      where: { sectionId: { in: sectionIds } },
    });
    const versions = await tx.manuscriptSectionVersion.deleteMany({
      where: { sectionId: { in: sectionIds } },
    });
    const sections = await tx.manuscriptSection.deleteMany({
      where: { id: { in: sectionIds }, manuscriptId: manuscript.id },
    });
    deletedCommentCount = replies.count + roots.count;
    deletedVersionCount = versions.count;
    deletedSectionCount = sections.count;
  }

  await tx.manuscriptSection.createMany({
    data: PICO_SECTIONS.map((section, order) => ({
      manuscriptId: manuscript.id,
      title: section.title,
      kind: section.kind,
      order,
      content: EMPTY_DOC as Prisma.InputJsonObject,
    })),
  });

  const sections = await tx.manuscriptSection.findMany({
    where: { manuscriptId: manuscript.id },
    orderBy: { order: "asc" },
  });
  const resetSummary = {
    trigger: options.trigger,
    deletedSectionCount,
    deletedCommentCount,
    deletedVersionCount,
    deletedWordCount: previousSections.reduce((sum, section) => sum + section.wordCount, 0),
    deletedAssignedSectionCount: previousSections.filter((section) => section.assigned).length,
    deletedLockedSectionCount: previousSections.filter((section) => section.locked).length,
  };

  await audit.record(tx, {
    projectId,
    userId: ctx.userId,
    entityType: "Manuscript",
    entityId: manuscript.id,
    action: AuditActions.MANUSCRIPT_RESET_TO_PICO_DEFAULTS,
    previousValue: { sections: previousSections },
    newValue: {
      sections: PICO_SECTIONS.map((section, order) => ({ ...section, order })),
    },
    metadata: resetSummary,
  });

  return {
    manuscriptId: manuscript.id,
    ...resetSummary,
    sections: sections.map((section) => ({
      id: section.id,
      title: section.title,
      kind: section.kind,
      order: section.order,
      status: section.status,
      wordCount: section.wordCount,
      version: section.version,
    })),
  };
}

export async function resetManuscriptToPicoDefaults(
  ctx: Ctx,
  projectId: string,
  rawInput: z.input<typeof resetToPicoDefaultsSchema>,
) {
  const input = resetToPicoDefaultsSchema.parse(rawInput);
  // Fast fail before opening the transaction; the same checks run again inside it.
  const member = await requirePermission(ctx, projectId, "manuscript.manage");
  if (!member.roles.includes("OWNER")) {
    throw forbidden("Only a project owner can replace the manuscript with PICO defaults");
  }
  return prisma.$transaction((tx) =>
    resetManuscriptToPicoDefaultsInTransaction(ctx, projectId, tx, {
      confirmDataLoss: input.confirmDataLoss,
      trigger: "EXISTING_SUBPROJECT",
    }),
  );
}

export async function createSection(
  ctx: Ctx,
  projectId: string,
  input: z.infer<typeof createSectionSchema>,
) {
  await requirePermission(ctx, projectId, "manuscript.manage");
  const manuscript = await getOrCreateManuscript(ctx, projectId);
  return prisma.$transaction(async (tx) => {
    const last = await tx.manuscriptSection.aggregate({
      where: { manuscriptId: manuscript.id },
      _max: { order: true },
    });
    const section = await tx.manuscriptSection.create({
      data: {
        manuscriptId: manuscript.id,
        title: input.title,
        kind: input.kind ?? "CUSTOM",
        order: (last._max.order ?? -1) + 1,
        content: EMPTY_DOC as Prisma.InputJsonObject,
      },
    });
    await audit.record(tx, {
      projectId,
      userId: ctx.userId,
      entityType: "ManuscriptSection",
      entityId: section.id,
      action: AuditActions.MANUSCRIPT_SECTION_CREATED,
      newValue: { title: section.title, kind: section.kind, order: section.order },
    });
    return section;
  });
}

export async function updateSection(
  ctx: Ctx,
  projectId: string,
  sectionId: string,
  input: z.infer<typeof updateSectionSchema>,
) {
  await requirePermission(ctx, projectId, "manuscript.manage");
  const before = await loadSection(prisma, projectId, sectionId);
  return prisma.$transaction(async (tx) => {
    const section = await tx.manuscriptSection.update({
      where: { id: before.id },
      data: {
        ...(input.title !== undefined ? { title: input.title } : {}),
        ...(input.kind !== undefined ? { kind: input.kind } : {}),
      },
    });
    await audit.record(tx, {
      projectId,
      userId: ctx.userId,
      entityType: "ManuscriptSection",
      entityId: section.id,
      action: AuditActions.MANUSCRIPT_SECTION_UPDATED,
      previousValue: { title: before.title, kind: before.kind },
      newValue: { title: section.title, kind: section.kind },
    });
    return section;
  });
}

export async function deleteSection(ctx: Ctx, projectId: string, sectionId: string) {
  await requirePermission(ctx, projectId, "manuscript.manage");
  const section = await loadSection(prisma, projectId, sectionId);
  const now = new Date();
  if (
    section.lockedById &&
    section.lockedById !== ctx.userId &&
    !isLockStale(section.lockHeartbeatAt, now)
  ) {
    throw conflict(`${section.lockedBy?.name ?? "Someone"} is editing this section right now`);
  }
  return prisma.$transaction(async (tx) => {
    // Self-referencing comment threads: delete replies before roots.
    await tx.manuscriptComment.deleteMany({
      where: { sectionId: section.id, parentId: { not: null } },
    });
    await tx.manuscriptComment.deleteMany({ where: { sectionId: section.id } });
    await tx.manuscriptSectionVersion.deleteMany({ where: { sectionId: section.id } });
    await tx.manuscriptSection.delete({ where: { id: section.id } });
    await audit.record(tx, {
      projectId,
      userId: ctx.userId,
      entityType: "ManuscriptSection",
      entityId: section.id,
      action: AuditActions.MANUSCRIPT_SECTION_DELETED,
      previousValue: { title: section.title, kind: section.kind, wordCount: section.wordCount },
    });
    return { deleted: true };
  });
}

export async function reorderSections(
  ctx: Ctx,
  projectId: string,
  input: z.infer<typeof reorderSectionsSchema>,
) {
  await requirePermission(ctx, projectId, "manuscript.manage");
  const manuscript = await getOrCreateManuscript(ctx, projectId);
  const sections = await prisma.manuscriptSection.findMany({
    where: { manuscriptId: manuscript.id },
    select: { id: true },
  });
  const current = new Set(sections.map((s) => s.id));
  const proposed = new Set(input.orderedIds);
  if (current.size !== proposed.size || [...current].some((id) => !proposed.has(id))) {
    throw validationError("orderedIds must contain exactly the manuscript's section ids");
  }
  return prisma.$transaction(async (tx) => {
    for (const [order, id] of input.orderedIds.entries()) {
      await tx.manuscriptSection.update({ where: { id }, data: { order } });
    }
    await audit.record(tx, {
      projectId,
      userId: ctx.userId,
      entityType: "Manuscript",
      entityId: manuscript.id,
      action: AuditActions.MANUSCRIPT_SECTIONS_REORDERED,
      newValue: { orderedIds: input.orderedIds },
    });
    return { reordered: true };
  });
}

export async function assignSection(
  ctx: Ctx,
  projectId: string,
  sectionId: string,
  input: z.infer<typeof assignSectionSchema>,
) {
  await requirePermission(ctx, projectId, "manuscript.manage");
  const section = await loadSection(prisma, projectId, sectionId);
  if (input.assigneeId) {
    const members = await activeMemberIds(projectId);
    if (!members.has(input.assigneeId)) throw notFound("Member");
  }
  return prisma.$transaction(async (tx) => {
    const updated = await tx.manuscriptSection.update({
      where: { id: section.id },
      data: { assigneeId: input.assigneeId },
      include: { assignee: userRef },
    });
    await audit.record(tx, {
      projectId,
      userId: ctx.userId,
      entityType: "ManuscriptSection",
      entityId: section.id,
      action: AuditActions.MANUSCRIPT_SECTION_ASSIGNED,
      previousValue: { assigneeId: section.assigneeId },
      newValue: { assigneeId: input.assigneeId },
    });
    if (input.assigneeId) {
      await notifications.emit(tx, {
        userIds: [input.assigneeId],
        projectId,
        type: NotificationTypes.MANUSCRIPT_SECTION_ASSIGNED,
        actorId: ctx.userId,
        payload: {
          sectionId: section.id,
          sectionTitle: section.title,
          snippet: `You were assigned the “${section.title}” section.`,
        },
      });
    }
    return updated;
  });
}

export async function setSectionStatus(
  ctx: Ctx,
  projectId: string,
  sectionId: string,
  input: z.infer<typeof sectionStatusSchema>,
) {
  const member = await requirePermission(ctx, projectId, "manuscript.view");
  const section = await loadSection(prisma, projectId, sectionId);
  if (section.status === input.status) return section;

  const involvesApproved = section.status === "APPROVED" || input.status === "APPROVED";
  if (involvesApproved) {
    if (!can(member.roles, "manuscript.manage")) {
      throw forbidden("Only manuscript managers can approve sections or reopen approved ones");
    }
  } else {
    assertCanEditSection(member, section, ctx.userId);
  }

  return prisma.$transaction(async (tx) => {
    const updated = await tx.manuscriptSection.update({
      where: { id: section.id },
      data: { status: input.status },
    });
    await audit.record(tx, {
      projectId,
      userId: ctx.userId,
      entityType: "ManuscriptSection",
      entityId: section.id,
      action: AuditActions.MANUSCRIPT_SECTION_STATUS_CHANGED,
      previousValue: { status: section.status },
      newValue: { status: updated.status },
    });
    return updated;
  });
}

// ---------------------------------------------------------------------------
// Locks (unaudited coordination state — takeover is the exception)
// ---------------------------------------------------------------------------

export async function acquireLock(
  ctx: Ctx,
  projectId: string,
  sectionId: string,
  input: z.infer<typeof acquireLockSchema>,
) {
  const member = await requirePermission(ctx, projectId, "manuscript.view");
  const now = new Date();
  return prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM "ManuscriptSection" WHERE id = ${sectionId} FOR UPDATE`;
    const section = await loadSection(tx, projectId, sectionId);
    assertCanEditSection(member, section, ctx.userId);
    assertNotApproved(section);

    const heldByOther = section.lockedById !== null && section.lockedById !== ctx.userId;
    const stale = isLockStale(section.lockHeartbeatAt, now);

    if (heldByOther && !stale) {
      // A fresh lock can never be stolen — worst wait is LOCK_STALE_MS.
      throw lockedConflict(section, false);
    }
    if (heldByOther && stale && input.takeover !== true) {
      throw lockedConflict(section, true);
    }

    if (heldByOther && stale && input.takeover === true) {
      // Preserve the previous editor's unsaved-to-version work, attributed to THEM.
      await cutVersionIfDirty(tx, section, "TAKEOVER", section.lockedById!);
      await audit.record(tx, {
        projectId,
        userId: ctx.userId,
        entityType: "ManuscriptSection",
        entityId: section.id,
        action: AuditActions.MANUSCRIPT_LOCK_TAKEN_OVER,
        previousValue: { lockedById: section.lockedById },
        newValue: { lockedById: ctx.userId },
      });
    }

    const updated = await tx.manuscriptSection.update({
      where: { id: section.id },
      data: { lockedById: ctx.userId, lockAcquiredAt: now, lockHeartbeatAt: now },
      include: { lockedBy: userRef, assignee: userRef },
    });
    return { lock: lockView(updated, now), version: updated.version };
  });
}

export async function heartbeatLock(ctx: Ctx, projectId: string, sectionId: string) {
  await requirePermission(ctx, projectId, "manuscript.view");
  const section = await loadSection(prisma, projectId, sectionId);
  if (section.lockedById !== ctx.userId) {
    throw conflict("You no longer hold the edit lock for this section");
  }
  const updated = await prisma.manuscriptSection.update({
    where: { id: section.id },
    data: { lockHeartbeatAt: new Date() },
  });
  return { heartbeatAt: updated.lockHeartbeatAt };
}

export async function releaseLock(ctx: Ctx, projectId: string, sectionId: string) {
  await requirePermission(ctx, projectId, "manuscript.view");
  return prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM "ManuscriptSection" WHERE id = ${sectionId} FOR UPDATE`;
    const section = await loadSection(tx, projectId, sectionId);
    // Non-holder release is a NO-OP success: a taken-over editor's unmount must not
    // clear the new holder's lock.
    if (section.lockedById !== ctx.userId) return { released: false };
    const version = await cutVersionIfDirty(tx, section, "LOCK_RELEASE", ctx.userId);
    if (version) {
      await audit.record(tx, {
        projectId,
        userId: ctx.userId,
        entityType: "ManuscriptSection",
        entityId: section.id,
        action: AuditActions.MANUSCRIPT_VERSION_CREATED,
        metadata: { versionNumber: version.versionNumber, origin: "LOCK_RELEASE" },
      });
    }
    await tx.manuscriptSection.update({
      where: { id: section.id },
      data: { lockedById: null, lockAcquiredAt: null, lockHeartbeatAt: null },
    });
    return { released: true };
  });
}

// ---------------------------------------------------------------------------
// Content (unaudited autosaves — versions are the audited record)
// ---------------------------------------------------------------------------

export async function saveSectionContent(
  ctx: Ctx,
  projectId: string,
  sectionId: string,
  input: z.infer<typeof saveContentSchema>,
) {
  const member = await requirePermission(ctx, projectId, "manuscript.view");
  const check = validateDoc(input.content);
  if (!check.ok) throw validationError(check.reason);

  return prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM "ManuscriptSection" WHERE id = ${sectionId} FOR UPDATE`;
    const section = await loadSection(tx, projectId, sectionId);
    assertCanEditSection(member, section, ctx.userId);
    assertNotApproved(section);

    const now = new Date();
    if (section.lockedById !== ctx.userId || isLockStale(section.lockHeartbeatAt, now)) {
      throw new AppError("CONFLICT", "You no longer hold the edit lock for this section", {
        reason: "LOCK_REQUIRED",
      });
    }
    if (section.version !== input.baseVersion) {
      throw new AppError("CONFLICT", "This section changed since you loaded it", {
        reason: "VERSION_MISMATCH",
        currentVersion: section.version,
      });
    }

    const contentText = extractDocText(input.content);
    const updated = await tx.manuscriptSection.update({
      where: { id: section.id },
      data: {
        content: input.content as Prisma.InputJsonObject,
        contentText,
        wordCount: countWords(contentText),
        version: section.version + 1,
        lockHeartbeatAt: now, // saving counts as activity
      },
    });
    return { version: updated.version, wordCount: updated.wordCount };
  });
}

// ---------------------------------------------------------------------------
// Versions
// ---------------------------------------------------------------------------

export async function listVersions(ctx: Ctx, projectId: string, sectionId: string) {
  await requirePermission(ctx, projectId, "manuscript.view");
  await loadSection(prisma, projectId, sectionId);
  return prisma.manuscriptSectionVersion.findMany({
    where: { sectionId },
    select: {
      id: true,
      versionNumber: true,
      origin: true,
      note: true,
      wordCount: true,
      createdAt: true,
      savedBy: userRef,
    },
    orderBy: { versionNumber: "desc" },
  });
}

export async function getVersion(
  ctx: Ctx,
  projectId: string,
  sectionId: string,
  versionId: string,
) {
  await requirePermission(ctx, projectId, "manuscript.view");
  await loadSection(prisma, projectId, sectionId);
  const version = await prisma.manuscriptSectionVersion.findFirst({
    where: { id: versionId, sectionId },
    include: { savedBy: userRef },
  });
  if (!version) throw notFound("Version");
  return version;
}

export async function createVersion(
  ctx: Ctx,
  projectId: string,
  sectionId: string,
  input: z.infer<typeof createVersionSchema>,
) {
  const member = await requirePermission(ctx, projectId, "manuscript.view");
  return prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM "ManuscriptSection" WHERE id = ${sectionId} FOR UPDATE`;
    const section = await loadSection(tx, projectId, sectionId);
    assertCanEditSection(member, section, ctx.userId);
    const version = await cutVersionIfDirty(
      tx,
      section,
      "EXPLICIT",
      ctx.userId,
      input.note,
      true, // explicit saves always cut, even when clean (the note is the point)
    );
    await audit.record(tx, {
      projectId,
      userId: ctx.userId,
      entityType: "ManuscriptSection",
      entityId: section.id,
      action: AuditActions.MANUSCRIPT_VERSION_CREATED,
      metadata: { versionNumber: version!.versionNumber, origin: "EXPLICIT", note: input.note ?? null },
    });
    return version!;
  });
}

export async function restoreVersion(
  ctx: Ctx,
  projectId: string,
  sectionId: string,
  versionId: string,
) {
  const member = await requirePermission(ctx, projectId, "manuscript.view");
  return prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM "ManuscriptSection" WHERE id = ${sectionId} FOR UPDATE`;
    const section = await loadSection(tx, projectId, sectionId);
    assertCanEditSection(member, section, ctx.userId);
    assertNotApproved(section);
    const now = new Date();
    if (section.lockedById !== ctx.userId || isLockStale(section.lockHeartbeatAt, now)) {
      throw conflict("Acquire the edit lock before restoring a version");
    }
    const target = await tx.manuscriptSectionVersion.findFirst({
      where: { id: versionId, sectionId },
    });
    if (!target) throw notFound("Version");

    await cutVersionIfDirty(tx, section, "RESTORE", ctx.userId, `Before restore to v${target.versionNumber}`);
    const updated = await tx.manuscriptSection.update({
      where: { id: section.id },
      data: {
        content: target.content as Prisma.InputJsonObject,
        contentText: target.contentText,
        wordCount: target.wordCount,
        version: section.version + 1,
        lockHeartbeatAt: now,
      },
    });
    await audit.record(tx, {
      projectId,
      userId: ctx.userId,
      entityType: "ManuscriptSection",
      entityId: section.id,
      action: AuditActions.MANUSCRIPT_VERSION_RESTORED,
      metadata: { fromVersionNumber: target.versionNumber },
    });
    return { version: updated.version, content: updated.content, wordCount: updated.wordCount };
  });
}

// ---------------------------------------------------------------------------
// Comments (one-level threads, @mentions → notifications)
// ---------------------------------------------------------------------------

export async function listComments(
  ctx: Ctx,
  projectId: string,
  sectionId: string,
  filter: { status?: "OPEN" | "RESOLVED" } = {},
) {
  await requirePermission(ctx, projectId, "manuscript.view");
  await loadSection(prisma, projectId, sectionId);
  const roots = await prisma.manuscriptComment.findMany({
    where: { sectionId, parentId: null, ...(filter.status ? { status: filter.status } : {}) },
    include: {
      author: userRef,
      resolvedBy: userRef,
      replies: { include: { author: userRef }, orderBy: { createdAt: "asc" } },
    },
    orderBy: { createdAt: "asc" },
  });
  return roots;
}

export async function createComment(
  ctx: Ctx,
  projectId: string,
  sectionId: string,
  input: z.infer<typeof createCommentSchema>,
) {
  await requirePermission(ctx, projectId, "manuscript.comment");
  const section = await loadSection(prisma, projectId, sectionId);

  const members = await activeMemberIds(projectId);
  const mentions = [...new Set(input.mentions ?? [])];
  for (const userId of mentions) {
    if (!members.has(userId)) throw validationError("Mentioned user is not an active member");
  }

  let parentAuthorId: string | null = null;
  if (input.parentId) {
    const parent = await prisma.manuscriptComment.findFirst({
      where: { id: input.parentId, sectionId },
    });
    if (!parent) throw notFound("Comment");
    if (parent.parentId !== null) {
      throw validationError("Replies can only be added to top-level comments");
    }
    parentAuthorId = parent.authorId;
  }

  return prisma.$transaction(async (tx) => {
    const comment = await tx.manuscriptComment.create({
      data: {
        sectionId: section.id,
        authorId: ctx.userId,
        parentId: input.parentId ?? null,
        body: input.body,
        quotedText: input.quotedText ?? null,
        mentions,
      },
      include: { author: userRef },
    });
    await audit.record(tx, {
      projectId,
      userId: ctx.userId,
      entityType: "ManuscriptComment",
      entityId: comment.id,
      action: AuditActions.MANUSCRIPT_COMMENT_CREATED,
      metadata: { sectionId: section.id, parentId: input.parentId ?? null, mentions },
    });

    const snippet = input.body.slice(0, 200);
    if (mentions.length > 0) {
      await notifications.emit(tx, {
        userIds: mentions,
        projectId,
        type: NotificationTypes.MANUSCRIPT_COMMENT_MENTION,
        actorId: ctx.userId,
        payload: { sectionId: section.id, sectionTitle: section.title, commentId: comment.id, snippet },
      });
    }
    if (parentAuthorId && !mentions.includes(parentAuthorId)) {
      await notifications.emit(tx, {
        userIds: [parentAuthorId],
        projectId,
        type: NotificationTypes.MANUSCRIPT_COMMENT_REPLY,
        actorId: ctx.userId,
        payload: { sectionId: section.id, sectionTitle: section.title, commentId: comment.id, snippet },
      });
    }
    return comment;
  });
}

export async function setCommentStatus(
  ctx: Ctx,
  projectId: string,
  sectionId: string,
  commentId: string,
  input: z.infer<typeof commentStatusSchema>,
) {
  await requirePermission(ctx, projectId, "manuscript.comment");
  await loadSection(prisma, projectId, sectionId);
  const comment = await prisma.manuscriptComment.findFirst({
    where: { id: commentId, sectionId },
  });
  if (!comment) throw notFound("Comment");
  if (comment.parentId !== null) throw invalidState("Only top-level comments can be resolved");
  if (comment.status === input.status) return comment;

  return prisma.$transaction(async (tx) => {
    const updated = await tx.manuscriptComment.update({
      where: { id: comment.id },
      data: {
        status: input.status,
        resolvedById: input.status === "RESOLVED" ? ctx.userId : null,
        resolvedAt: input.status === "RESOLVED" ? new Date() : null,
      },
    });
    await audit.record(tx, {
      projectId,
      userId: ctx.userId,
      entityType: "ManuscriptComment",
      entityId: comment.id,
      action:
        input.status === "RESOLVED"
          ? AuditActions.MANUSCRIPT_COMMENT_RESOLVED
          : AuditActions.MANUSCRIPT_COMMENT_REOPENED,
    });
    return updated;
  });
}

export async function deleteComment(
  ctx: Ctx,
  projectId: string,
  sectionId: string,
  commentId: string,
) {
  const member = await requirePermission(ctx, projectId, "manuscript.comment");
  await loadSection(prisma, projectId, sectionId);
  const comment = await prisma.manuscriptComment.findFirst({
    where: { id: commentId, sectionId },
    include: { _count: { select: { replies: true } } },
  });
  if (!comment) throw notFound("Comment");

  const isManager = can(member.roles, "manuscript.manage");
  if (!isManager) {
    if (comment.authorId !== ctx.userId) throw forbidden("You can only delete your own comments");
    if (comment._count.replies > 0) {
      throw invalidState("This comment has replies — a manuscript manager can delete the thread");
    }
  }

  return prisma.$transaction(async (tx) => {
    await tx.manuscriptComment.deleteMany({ where: { parentId: comment.id } });
    await tx.manuscriptComment.delete({ where: { id: comment.id } });
    await audit.record(tx, {
      projectId,
      userId: ctx.userId,
      entityType: "ManuscriptComment",
      entityId: comment.id,
      action: AuditActions.MANUSCRIPT_COMMENT_DELETED,
      previousValue: { body: comment.body.slice(0, 200), authorId: comment.authorId },
      metadata: { byManager: isManager && comment.authorId !== ctx.userId },
    });
    return { deleted: true };
  });
}

// ---------------------------------------------------------------------------
// Citations (cite-map) — delegates formatting to the reference library
// ---------------------------------------------------------------------------

// Shared cite-map assembly for one or many manuscripts' section contents. `projectId`
// is the project whose reference library scope formats the bibliography — for guideline
// families every project resolves to the same shared root pool, so reference ids are
// interchangeable across the family's manuscripts.
async function buildCiteMap(
  ctx: Ctx,
  projectId: string,
  citationStyleId: string | null,
  contents: unknown[],
) {
  const orderedIds = collectCitationRefs(contents);
  // The stored citationStyleId is a plain string; fall back to the default when it is
  // absent or no longer a known style.
  const styleParse = references.bibliographySchema.shape.styleId.safeParse(
    citationStyleId ?? undefined,
  );
  const bib = await references.formatBibliography(ctx, projectId, {
    styleId: styleParse.success ? styleParse.data : undefined,
    referenceIds: orderedIds.length > 0 ? orderedIds : undefined,
  });

  const markers: Record<string, string> = {};
  for (const entry of bib.entries) {
    // Marker CORE: for author-year styles previewCitationCluster returns "(…)" — strip
    // the outer parens so the chip/docx grouping controls the wrapping.
    markers[entry.referenceId] = bib.numeric
      ? entry.citeMarker
      : entry.citeMarker.replace(/^\(/, "").replace(/\)$/, "");
  }
  return {
    styleId: bib.styleId,
    numeric: bib.numeric,
    markers,
    orderedReferenceIds: orderedIds,
    bibliography: bib.entries
      .filter((e) => orderedIds.length === 0 || orderedIds.includes(e.referenceId))
      .map((e) => ({ referenceId: e.referenceId, index: e.index, html: e.html, text: e.text })),
  };
}

export async function getCiteMap(ctx: Ctx, projectId: string) {
  await requirePermission(ctx, projectId, "manuscript.view");
  const manuscript = await getOrCreateManuscript(ctx, projectId);
  const sections = await prisma.manuscriptSection.findMany({
    where: { manuscriptId: manuscript.id },
    select: { content: true },
    orderBy: { order: "asc" },
  });
  return buildCiteMap(ctx, projectId, manuscript.citationStyleId, sections.map((s) => s.content));
}

// ---------------------------------------------------------------------------
// DOCX export
// ---------------------------------------------------------------------------

// manuscript.view-gated (the export contains exactly what the viewer already sees on
// screen — export.create would deny e.g. PANEL_MEMBER a copy of a page they can read).
// Audited. No ExportJob row: this is a direct document artifact like the PRISMA diagram
// downloads, not the CSV/JSON export pipeline.
export async function exportDocx(
  ctx: Ctx,
  projectId: string,
): Promise<{ filename: string; buffer: Uint8Array }> {
  await requirePermission(ctx, projectId, "manuscript.view");
  const manuscript = await getOrCreateManuscript(ctx, projectId);
  const [project, sections, citeMap] = await Promise.all([
    prisma.project.findUniqueOrThrow({ where: { id: projectId }, select: { title: true } }),
    prisma.manuscriptSection.findMany({
      where: { manuscriptId: manuscript.id },
      orderBy: { order: "asc" },
    }),
    getCiteMap(ctx, projectId),
  ]);

  const { docToBlocks, offsetNumberingGroups } = await import("@/lib/manuscript/docx-map");
  const { formatCiteMarker } = await import("@/lib/manuscript/cite-format");
  const { buildManuscriptDocx } = await import("./docx");

  const sectionBlocks = offsetNumberingGroups(
    sections.map((s) => docToBlocks(s.content, (ids) => formatCiteMarker(ids, citeMap))),
  );
  const buffer = await buildManuscriptDocx({
    projectTitle: project.title,
    manuscriptTitle: manuscript.title === "Manuscript" ? project.title : manuscript.title,
    sections: sections.map((s, i) => ({
      title: s.title,
      kind: s.kind,
      blocks: sectionBlocks[i] ?? [],
    })),
    bibliography: citeMap.bibliography.map((e) => ({ index: e.index, text: e.text })),
    numericStyle: citeMap.numeric,
  });

  const slug = project.title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
  const filename = `${slug || "manuscript"}-manuscript.docx`;

  await prisma.$transaction(async (tx) => {
    await audit.record(tx, {
      projectId,
      userId: ctx.userId,
      entityType: "Manuscript",
      entityId: manuscript.id,
      action: AuditActions.MANUSCRIPT_EXPORTED,
      metadata: {
        sectionCount: sections.length,
        wordCount: sections.reduce((sum, s) => sum + s.wordCount, 0),
        referenceCount: citeMap.bibliography.length,
      },
    });
  });
  return { filename, buffer };
}

// ---------------------------------------------------------------------------
// Compiled guideline (parent's general sections + every PICO's sections)
// ---------------------------------------------------------------------------

interface GuidelinePart {
  project: { id: string; title: string; researchQuestion: string | null };
  isParent: boolean;
  manuscript: { id: string; title: string; citationStyleId: string | null };
  sections: ManuscriptSection[];
}

// Loads the parent manuscript plus each sub-project manuscript the caller may view.
// Per-sub access follows the caller's OWN membership in that sub-project — being able
// to read the guideline does not grant its PICO manuscripts. Inaccessible subs come
// back in `skipped` (their titles are already org-visible via the project list).
async function loadGuidelineParts(ctx: Ctx, projectId: string) {
  await requirePermission(ctx, projectId, "manuscript.view");
  const project = await prisma.project.findUnique({
    where: { id: projectId },
    select: {
      id: true,
      title: true,
      researchQuestion: true,
      isGuideline: true,
      subProjects: {
        select: { id: true, title: true, researchQuestion: true },
        orderBy: { createdAt: "asc" },
      },
    },
  });
  if (!project) throw notFound("Project");
  if (!project.isGuideline) {
    throw invalidState("Only guideline projects have a compiled guideline document");
  }

  const accessible: typeof project.subProjects = [];
  const skipped: { projectId: string; projectTitle: string }[] = [];
  for (const sub of project.subProjects) {
    const membership = await getMembership(ctx.userId, sub.id);
    if (membership && can(membership.roles, "manuscript.view")) accessible.push(sub);
    else skipped.push({ projectId: sub.id, projectTitle: sub.title });
  }

  const loadPart = async (
    source: { id: string; title: string; researchQuestion: string | null },
    isParent: boolean,
  ): Promise<GuidelinePart> => {
    const manuscript = await getOrCreateManuscript(ctx, source.id);
    const sections = await prisma.manuscriptSection.findMany({
      where: { manuscriptId: manuscript.id },
      orderBy: { order: "asc" },
    });
    return {
      project: { id: source.id, title: source.title, researchQuestion: source.researchQuestion },
      isParent,
      manuscript: {
        id: manuscript.id,
        title: manuscript.title,
        citationStyleId: manuscript.citationStyleId,
      },
      sections,
    };
  };

  const parent = await loadPart(project, true);
  const subParts: GuidelinePart[] = [];
  for (const sub of accessible) subParts.push(await loadPart(sub, false));
  return { project, parent, parts: [parent, ...subParts], skipped };
}

// Structural outline of the full guideline document for the compile panel.
export async function getCompiledGuideline(ctx: Ctx, projectId: string) {
  const { project, parent, parts, skipped } = await loadGuidelineParts(ctx, projectId);
  return {
    title: parent.manuscript.title === "Manuscript" ? project.title : parent.manuscript.title,
    citationStyleId: parent.manuscript.citationStyleId,
    canExportAll: skipped.length === 0,
    parts: parts.map((part, index) => ({
      projectId: part.project.id,
      projectTitle: part.project.title,
      researchQuestion: part.project.researchQuestion,
      isParent: part.isParent,
      picoNumber: part.isParent ? null : index, // parts[0] is the parent
      sections: part.sections.map((s) => ({
        id: s.id,
        title: s.title,
        kind: s.kind,
        status: s.status,
        wordCount: s.wordCount,
      })),
    })),
    skipped,
    totalWordCount: parts.reduce(
      (sum, part) => sum + part.sections.reduce((inner, s) => inner + s.wordCount, 0),
      0,
    ),
  };
}

// One DOCX for the whole guideline: the parent's general sections first, then each
// PICO sub-project as its own numbered part, with ONE bibliography numbered across the
// entire document (possible because the family shares a single reference library).
// Requires manuscript access to EVERY sub-project — a partial guideline export would
// silently misrepresent the document, so missing access is a hard error instead.
export async function exportGuidelineDocx(
  ctx: Ctx,
  projectId: string,
): Promise<{ filename: string; buffer: Uint8Array }> {
  const { project, parent, parts, skipped } = await loadGuidelineParts(ctx, projectId);
  if (skipped.length > 0) {
    throw forbidden(
      `Exporting the full guideline needs manuscript access to every PICO sub-project. Missing: ${skipped
        .map((s) => s.projectTitle)
        .join(", ")}`,
    );
  }

  const citeMap = await buildCiteMap(
    ctx,
    projectId,
    parent.manuscript.citationStyleId,
    parts.flatMap((part) => part.sections.map((s) => s.content)),
  );

  const { docToBlocks, offsetNumberingGroups } = await import("@/lib/manuscript/docx-map");
  const { formatCiteMarker } = await import("@/lib/manuscript/cite-format");
  const { buildGuidelineDocx } = await import("./docx");

  const flatSections = parts.flatMap((part) => part.sections);
  const flatBlocks = offsetNumberingGroups(
    flatSections.map((s) => docToBlocks(s.content, (ids) => formatCiteMarker(ids, citeMap))),
  );
  let cursor = 0;
  const docParts = parts.map((part, index) => ({
    heading: part.isParent ? null : `PICO ${index}. ${part.project.title}`,
    subtitle: part.isParent ? null : part.project.researchQuestion,
    sections: part.sections.map((s) => ({
      title: s.title,
      kind: s.kind,
      blocks: flatBlocks[cursor++] ?? [],
    })),
  }));

  const title = parent.manuscript.title === "Manuscript" ? project.title : parent.manuscript.title;
  const buffer = await buildGuidelineDocx({
    projectTitle: project.title,
    manuscriptTitle: title,
    parts: docParts,
    bibliography: citeMap.bibliography.map((e) => ({ index: e.index, text: e.text })),
    numericStyle: citeMap.numeric,
  });

  const slug = project.title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
  const filename = `${slug || "guideline"}-guideline.docx`;

  await prisma.$transaction(async (tx) => {
    await audit.record(tx, {
      projectId,
      userId: ctx.userId,
      entityType: "Manuscript",
      entityId: parent.manuscript.id,
      action: AuditActions.MANUSCRIPT_EXPORTED,
      metadata: {
        compiledGuideline: true,
        projectCount: parts.length,
        sectionCount: flatSections.length,
        wordCount: flatSections.reduce((sum, s) => sum + s.wordCount, 0),
        referenceCount: citeMap.bibliography.length,
      },
    });
  });
  return { filename, buffer };
}
