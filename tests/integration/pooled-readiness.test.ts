import { beforeAll, expect, it, vi } from "vitest";
import { prisma } from "@/server/db";
import * as audit from "@/server/services/audit";
import * as quotas from "@/server/services/screening/quotas";
import * as imports from "@/server/services/imports";
import { resetDb } from "../db-utils";
import { pooledReadinessFixture } from "../fixtures/pooled-readiness";

beforeAll(resetDb);
type Fixture = Awaited<ReturnType<typeof pooledReadinessFixture>>;
const ids = (f: Fixture, index: number) => f.groups[index]!.map((c) => c.id);
const target = (f: Fixture, value: number) =>
  quotas.saveQuotas(
    { userId: f.owner.id },
    f.guideline.id,
    { poolId: f.pool.id },
    { reviewers: [{ reviewerId: f.users[0]!.id, target: value }] },
  );
async function seedReviews(f: Fixture, start: number, end: number) {
  const pairs = f.groups
    .slice(start, end)
    .flat()
    .map((c) => ({
      citationId: c.id,
      stageId: c.stageId,
      reviewerId: f.users[0]!.id,
    }));
  await prisma.screeningAssignment.createMany({
    data: pairs.map((p) => ({ ...p, status: "COMPLETED" })),
  });
  await prisma.screeningDecision.createMany({
    data: pairs.map((p) => ({
      ...p,
      decision: "INCLUDE",
      notes: "Historical review",
    })),
  });
}
const counts = async (f: Fixture) => ({
  assignments: await prisma.screeningAssignment.count({
    where: { citationId: { in: f.groups.flat().map((c) => c.id) } },
  }),
  decisions: await prisma.screeningDecision.count({
    where: { citationId: { in: f.groups.flat().map((c) => c.id) } },
  }),
  results: await prisma.citationStageResult.count({
    where: { citationId: { in: f.groups.flat().map((c) => c.id) } },
  }),
  audits: await prisma.auditEvent.count({
    where: { projectId: { in: f.picos.map((p) => p.id) } },
  }),
});

it("credits A2/A3/A5 once, preserves legacy pending rows, and audits notes/reason revisions per copy", async () => {
  const f = await pooledReadinessFixture();
  expect(f.groups[0]!.map((c) => c.projectId)).toEqual([
    f.picos[1]!.id,
    f.picos[2]!.id,
    f.picos[4]!.id,
  ]);
  const pending = await prisma.screeningAssignment.create({
    data: {
      stageId: f.groups[0]![0]!.stageId,
      citationId: ids(f, 0)[0]!,
      reviewerId: f.users[0]!.id,
    },
  });
  const otherPending = await prisma.screeningAssignment.create({
    data: {
      stageId: f.groups[0]![1]!.stageId,
      citationId: ids(f, 0)[1]!,
      reviewerId: f.users[2]!.id,
    },
  });
  const before = await counts(f);
  await f.queue();
  await f.queue(1, { q: "readiness" });
  expect(await counts(f)).toEqual(before);
  await f.decide(0, 2); // Skip A, choose C without any reservation.
  expect(
    (await f.queue()).items.some((item) =>
      item.citationIds.includes(ids(f, 0)[0]!),
    ),
  ).toBe(true);
  expect(
    (await f.queue(1)).items.some((item) =>
      item.citationIds.includes(ids(f, 0)[0]!),
    ),
  ).toBe(true);
  await f.decide(0, 0, "EXCLUDE", "Original note");
  expect((await f.queue()).quota).toEqual({
    target: 10,
    completed: 2,
    remaining: 8,
  });
  expect(
    await prisma.screeningAssignment.findUnique({ where: { id: pending.id } }),
  ).toMatchObject({ status: "COMPLETED" });
  expect(
    await prisma.screeningAssignment.findUnique({
      where: { id: otherPending.id },
    }),
  ).toMatchObject({ status: "PENDING" });
  await f.decide(0, 0, "EXCLUDE", "Revised note");
  const decisions = await prisma.screeningDecision.findMany({
    where: { citationId: { in: ids(f, 0) } },
    include: { exclusionReason: true },
  });
  expect(decisions).toHaveLength(3);
  expect(
    decisions.every(
      (d) =>
        d.notes === "Revised note" &&
        d.exclusionReason?.label === "Wrong population",
    ),
  ).toBe(true);
  expect((await f.queue()).quota?.completed).toBe(2);
  const events = await prisma.auditEvent.findMany({
    where: { entityId: { in: decisions.map((d) => d.id) } },
  });
  expect(
    events.filter((e) => e.action === "screening.decision.created"),
  ).toHaveLength(3);
  expect(
    events.filter((e) => e.action === "screening.decision.updated"),
  ).toHaveLength(3);
  for (const event of events) {
    expect(event.userId).toBe(f.users[0]!.id);
    expect(event.metadata).toMatchObject({
      pooledGuidelineId: f.guideline.id,
      pooledScreeningPoolId: f.pool.id,
      pooledCitationIds: expect.arrayContaining(ids(f, 0)),
    });
    if (event.action.endsWith("updated"))
      expect(event.previousValue).toMatchObject({ notes: "Original note" });
  }
});

it("fails closed for legacy state inconsistencies and gives no quota credit to orphan completed markers", async () => {
  const f = await pooledReadinessFixture({ count: 8 });
  for (let index = 1; index <= 5; index++) await f.decide(0, index);
  const orphan = f.groups[0]![0]!;
  await prisma.screeningAssignment.create({
    data: {
      stageId: orphan.stageId,
      citationId: orphan.id,
      reviewerId: f.users[0]!.id,
      status: "COMPLETED",
    },
  });
  // Missing vote, voided vote, mismatched reviewer set, note, result, and conflict.
  await prisma.screeningDecision.deleteMany({
    where: { citationId: ids(f, 1)[0] },
  });
  await prisma.screeningAssignment.updateMany({
    where: { citationId: ids(f, 2)[0] },
    data: { status: "VOIDED" },
  });
  await prisma.screeningAssignment.updateMany({
    where: { citationId: ids(f, 3)[0] },
    data: { reviewerId: f.users[1]!.id },
  });
  await prisma.screeningDecision.updateMany({
    where: { citationId: ids(f, 3)[0] },
    data: { reviewerId: f.users[1]!.id },
  });
  await prisma.screeningDecision.updateMany({
    where: { citationId: ids(f, 4)[0] },
    data: { notes: "Divergent note" },
  });
  await prisma.citationStageResult.create({
    data: {
      stageId: f.groups[5]![0]!.stageId,
      citationId: ids(f, 5)[0]!,
      outcome: "EXCLUDE",
      resolvedVia: "ADJUDICATION",
    },
  });
  await prisma.screeningConflict.create({
    data: { stageId: f.groups[6]![0]!.stageId, citationId: ids(f, 6)[0]! },
  });
  const before = await counts(f);
  const admin = await f.queue(-1, { status: "ALL" });
  expect(admin.adminSummary).toMatchObject({
    needsSynchronization: 7,
    finalized: 0,
    fullyReviewed: 0,
    needsAdditionalReviews: 1,
  });
  expect(admin.items.filter((i) => i.needsSynchronization)).toHaveLength(7);
  expect((await f.queue()).quota?.completed).toBe(5); // Real historical reviews keep credit; the orphan gets none.
  expect((await f.queue(2)).total).toBe(1);
  for (let index = 0; index < 7; index++)
    await expect(f.decide(2, index)).rejects.toMatchObject({
      code: "INVALID_STATE",
      message: expect.stringContaining("synchronization"),
    });
  expect(await counts(f)).toEqual(before);
  // A VOIDED marker without a decision blocks that reviewer, not another reviewer's valid quota.
  const valid = f.groups[7]![0]!;
  const voided = await prisma.screeningAssignment.create({
    data: {
      stageId: valid.stageId,
      citationId: valid.id,
      reviewerId: f.users[0]!.id,
      status: "VOIDED",
    },
  });
  await expect(f.decide(0, 7)).rejects.toMatchObject({ code: "FORBIDDEN" });
  await f.decide(2, 7);
  expect(
    await prisma.screeningAssignment.findUnique({ where: { id: voided.id } }),
  ).toMatchObject({ status: "VOIDED" });
});

it("enforces exact 199/200/201 and raised/lowered/zero targets without deleting history", async () => {
  const f = await pooledReadinessFixture({ count: 205 });
  await seedReviews(f, 0, 199);
  await target(f, 200);
  expect((await f.queue()).quota).toEqual({
    target: 200,
    completed: 199,
    remaining: 1,
  });
  await f.decide(0, 199);
  expect((await f.queue()).quota).toEqual({
    target: 200,
    completed: 200,
    remaining: 0,
  });
  await expect(f.decide(0, 200)).rejects.toMatchObject({
    code: "INVALID_STATE",
  });
  await target(f, 250);
  expect((await f.queue()).quota).toEqual({
    target: 250,
    completed: 200,
    remaining: 50,
  });
  await f.decide(0, 200);
  await target(f, 200);
  expect((await f.queue()).quota).toEqual({
    target: 200,
    completed: 201,
    remaining: 0,
  });
  const before = await counts(f);
  for (const value of [150, 0]) {
    await target(f, value);
    expect((await f.queue()).quota).toEqual({
      target: value,
      completed: 201,
      remaining: 0,
    });
    await expect(f.decide(0, 201)).rejects.toMatchObject({
      code: "INVALID_STATE",
    });
    expect((await f.queue(0, { status: "MY_REVIEWED" })).total).toBe(201);
  }
  expect(await counts(f)).toEqual(before);
  const lower = await pooledReadinessFixture({ count: 176 });
  await seedReviews(lower, 0, 175);
  await target(lower, 200);
  await target(lower, 150);
  expect((await lower.queue()).quota).toEqual({
    target: 150,
    completed: 175,
    remaining: 0,
  });
  await expect(lower.decide(0, 175)).rejects.toMatchObject({
    code: "INVALID_STATE",
  });
  const empty = await pooledReadinessFixture({ count: 0 });
  expect(await empty.queue()).toMatchObject({
    total: 0,
    quota: { remaining: 10, completed: 0 },
  });
});

it.each(["screening.result.created", "screening.decision.updated"])(
  "rolls back later %s failures including earlier results, notes, reasons and audits",
  async (action) => {
    const f = await pooledReadinessFixture();
    await f.decide(0, 0, "INCLUDE", "Retained note");
    const before = await counts(f);
    const previous = await prisma.screeningDecision.findMany({
      where: { citationId: { in: ids(f, 0) } },
      orderBy: { id: "asc" },
    });
    const original = audit.record;
    let writes = 0;
    const spy = vi
      .spyOn(audit, "record")
      .mockImplementation(async (tx, input) => {
        if (input.action === action && ++writes === 2)
          throw new Error("Injected later linked write failure");
        return original(tx, input);
      });
    try {
      await expect(
        f.decide(
          action.endsWith("updated") ? 0 : 1,
          0,
          action.endsWith("updated") ? "EXCLUDE" : "INCLUDE",
          "New note",
        ),
      ).rejects.toThrow("Injected later linked");
      expect(writes).toBe(2);
    } finally {
      spy.mockRestore();
    }
    expect(await counts(f)).toEqual(before);
    expect(
      await prisma.screeningDecision.findMany({
        where: { citationId: { in: ids(f, 0) } },
        orderBy: { id: "asc" },
      }),
    ).toEqual(previous);
    expect((await f.queue()).quota?.completed).toBe(1);
    expect((await f.queue(1)).quota?.completed).toBe(0);
    await f.decide(1, 0);
    expect(
      (await f.queue(0, { status: "MY_REVIEWED" })).items[0],
    ).toMatchObject({ canDecide: false, finalOutcome: "INCLUDE" });
    await expect(f.decide(0, 0, "MAYBE")).rejects.toMatchObject({
      code: "INVALID_STATE",
    });
  },
);

it("allows unrelated pooled transactions to commit while protecting corpus changes", async () => {
  const f = await pooledReadinessFixture();
  const importedProjectId = f.picos[3]!.id;
  const source = await imports.createImportSource(
    { userId: f.owner.id },
    importedProjectId,
    { name: "Concurrent import" },
  );
  const batch = await imports.createBatch(
    { userId: f.owner.id },
    importedProjectId,
    {
      sourceId: source.id,
      filename: "linked.ris",
      content:
        "TY  - JOUR\nTI  - Readiness abstract 0000\nDO  - 10.6000/readiness-0\nER  - ",
    },
  );
  let release!: () => void;
  let entered!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const ready = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const original = audit.record;
  const spy = vi
    .spyOn(audit, "record")
    .mockImplementation(async (tx, input) => {
      if (
        input.action === "screening.decision.created" &&
        input.userId === f.users[0]!.id
      ) {
        entered();
        await held;
      }
      return original(tx, input);
    });
  const first = f.decide(0, 0);
  let corpusChange: Promise<unknown> | undefined;
  let quotaChange: Promise<unknown> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await ready;
    let changed = false;
    let quotaChanged = false;
    const second = f.decide(1, 1);
    const outcome = await Promise.race([
      second.then(() => "committed"),
      new Promise<string>((resolve) => {
        timer = setTimeout(() => resolve("blocked"), 2000);
      }),
    ]);
    expect(outcome).toBe("committed");
    quotaChange = target(f, 0).then(() => {
      quotaChanged = true;
    });
    corpusChange = imports
      .commitBatch({ userId: f.owner.id }, importedProjectId, batch.id)
      .then(() => {
        changed = true;
      });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(changed).toBe(false);
    expect(quotaChanged).toBe(false);
    await second;
  } finally {
    release();
    if (timer) clearTimeout(timer);
    await Promise.all([first, corpusChange, quotaChange]);
    spy.mockRestore();
  }
  expect((await f.queue()).quota).toEqual({
    target: 0,
    completed: 1,
    remaining: 0,
  });
  const imported = await prisma.citation.findFirstOrThrow({
    where: { projectId: importedProjectId, doi: "10.6000/readiness-0" },
  });
  expect(
    await prisma.screeningDecision.count({
      where: { citationId: imported.id },
    }),
  ).toBe(0);
  const after = await f.queue(-1, { status: "ALL" });
  expect(
    after.items.find((i) => i.citationIds.includes(imported.id)),
  ).toMatchObject({ needsSynchronization: true, canDecide: false });
});

it("keeps owner/admin health identical and all navigator projections free of other reviewers' votes and identities", async () => {
  const f = await pooledReadinessFixture();
  await prisma.projectMember.updateMany({
    where: {
      userId: f.users[2]!.id,
      projectId: { in: [f.guideline.id, ...f.picos.map((p) => p.id)] },
    },
    data: { roles: ["ADMIN"] },
  });
  await f.decide(0, 0, "EXCLUDE", "PRIVATE_REVIEWER_ZERO_NOTE");
  await f.decide(1, 1, "MAYBE", "PRIVATE_REVIEWER_ONE_NOTE");
  const owner = await f.queue(-1, { status: "ALL" });
  const admin = await f.queue(2, { status: "ALL" });
  expect(owner.summary.available).toBe(0);
  expect(admin.summary.available).toBe(4);
  expect(owner.adminSummary).toEqual(admin.adminSummary);
  for (const result of [
    owner,
    admin,
    await f.queue(1),
    await f.queue(1, { status: "MY_REVIEWED" }),
  ]) {
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain("PRIVATE_REVIEWER_ZERO_NOTE");
    expect(serialized).not.toContain(f.users[0]!.id);
    expect(serialized).not.toContain(f.users[0]!.name);
    expect(serialized).not.toContain('"decision":"EXCLUDE"');
    expect(serialized).not.toContain('"conflict"');
  }
});
