import { beforeAll, expect, it } from "vitest";
import { PrismaClient } from "@prisma/client";
import { performance } from "node:perf_hooks";
import { listQuotas } from "@/server/services/screening/quotas";
import { prisma } from "@/server/db";
import { resetDb } from "../db-utils";
import { pooledReadinessFixture } from "../fixtures/pooled-readiness";

beforeAll(resetDb);
const percentile = (values: number[], p: number) =>
  Math.round(
    [...values].sort((a, b) => a - b)[
      Math.min(values.length - 1, Math.floor(values.length * p))
    ] ?? 0,
  );

it("measures realistic pooled query/decision contention and enforces exact review capacity", async () => {
  const f = await pooledReadinessFixture({
    count: 4110,
    reviewers: 40,
    seededProgress: true,
  });
  const queries: Record<string, { ms: number; total: number; bytes: number }> =
    {};
  for (const [name, user, query] of [
    ["available", 0, {}],
    ["title", 0, { q: "Readiness abstract 3600" }],
    ["doi", 0, { q: "10.6000/readiness-3600" }],
    ["pmid", 0, { q: "803600" }],
    ["reviewed", 0, { status: "MY_REVIEWED" }],
    ["page2", 0, { page: 2 }],
    ["admin", -1, { status: "ALL" }],
  ] as const) {
    const start = performance.now();
    const response = await f.queue(user, query);
    queries[name] = {
      ms: Math.round(performance.now() - start),
      total: response.pagination.total,
      bytes: Buffer.byteLength(JSON.stringify(response)),
    };
  }
  const monitor = new PrismaClient({
    datasourceUrl: process.env.TEST_DATABASE_URL,
  });
  const deadlocksBefore = await monitor.$queryRaw<
    { deadlocks: bigint }[]
  >`SELECT deadlocks FROM pg_stat_database WHERE datname = current_database()`;
  let deadlocks = 0;
  let phase: "different" | "overlapping" = "different";
  const phases = {
    different: { maxBlocked: 0, maxTransactionAgeMs: 0 },
    overlapping: { maxBlocked: 0, maxTransactionAgeMs: 0 },
  };
  let measuring = true;
  let maxBlocked = 0;
  let maxTransactionAgeMs = 0;
  let samples = 0;
  const sampler = (async () => {
    while (measuring) {
      const rows = await monitor.$queryRaw<
        { blocked: number; ageMs: number }[]
      >`
        SELECT count(*) FILTER (WHERE wait_event_type = 'Lock')::int AS blocked,
          COALESCE(max(EXTRACT(EPOCH FROM (clock_timestamp() - xact_start)) * 1000), 0)::float8 AS "ageMs"
        FROM pg_stat_activity WHERE datname = current_database() AND pid <> pg_backend_pid() AND xact_start IS NOT NULL`;
      maxBlocked = Math.max(maxBlocked, rows[0]!.blocked);
      maxTransactionAgeMs = Math.max(maxTransactionAgeMs, rows[0]!.ageMs);
      phases[phase].maxBlocked = Math.max(
        phases[phase].maxBlocked,
        rows[0]!.blocked,
      );
      phases[phase].maxTransactionAgeMs = Math.max(
        phases[phase].maxTransactionAgeMs,
        Math.round(rows[0]!.ageMs),
      );
      samples++;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  })();
  const burst = async (jobs: (() => Promise<unknown>)[]) => {
    const results = await Promise.all(
      jobs.map(async (run) => {
        const started = performance.now();
        try {
          await run();
          return { status: "success", ms: performance.now() - started };
        } catch (error) {
          const failure = error as {
            code?: string;
            message?: string;
            meta?: unknown;
          };
          return {
            status:
              failure.code === "INVALID_STATE" &&
              failure.message?.includes("all required reviews")
                ? "stale"
                : "error",
            ms: performance.now() - started,
            code: failure.code,
            message: failure.message?.slice(0, 200),
          };
        }
      }),
    );
    const latencies = results.map((r) => r.ms);
    return {
      success: results.filter((r) => r.status === "success").length,
      stale: results.filter((r) => r.status === "stale").length,
      errors: results.filter((r) => r.status === "error"),
      latencyMs: {
        min: percentile(latencies, 0),
        median: percentile(latencies, 0.5),
        p95: percentile(latencies, 0.95),
        max: percentile(latencies, 1),
      },
    };
  };
  let different;
  let overlapping;
  try {
    different = await burst(
      f.users.map((_, index) => () => f.decide(index, 3600 + index)),
    );
    await f.decide(0, 3700);
    phase = "overlapping";
    overlapping = await burst(
      f.users.slice(1).map((_, index) => () => f.decide(index + 1, 3700)),
    );
  } finally {
    measuring = false;
    await sampler;
    const after = await monitor.$queryRaw<
      { deadlocks: bigint }[]
    >`SELECT deadlocks FROM pg_stat_database WHERE datname = current_database()`;
    deadlocks = Number(after[0]!.deadlocks - deadlocksBefore[0]!.deadlocks);
    await monitor.$disconnect();
  }
  const report = {
    seed: {
      abstracts: 4110,
      citations: 9203,
      reviewers: 40,
      completedLogicalReviews: 5600,
    },
    queries,
    different,
    overlapping,
    deadlocks,
    phases,
    lockSamples: {
      samples,
      maxBlocked,
      maxTransactionAgeMs: Math.round(maxTransactionAgeMs),
    },
  };
  console.info(`POOLED_CONTENTION ${JSON.stringify(report)}`);
  expect(deadlocks).toBe(0);
  expect(different.errors).toEqual([]);
  expect(different.success).toBe(40);
  expect(overlapping.errors).toEqual([]);
  expect(overlapping.success).toBe(1);
  expect(overlapping.stale).toBe(38);
  const sharedIds = f.groups[3700]!.map((c) => c.id);
  const shared = await prisma.screeningDecision.findMany({
    where: { citationId: { in: sharedIds } },
    select: { reviewerId: true },
  });
  expect(new Set(shared.map((d) => d.reviewerId)).size).toBe(2);
  expect(shared.length).toBe(sharedIds.length * 2);
  const winners = new Set(shared.map((d) => d.reviewerId));
  const quotaRows = await listQuotas({ userId: f.owner.id }, f.guideline.id, {
    poolId: f.pool.id,
  });
  for (const user of f.users) {
    expect(
      quotaRows.reviewers.find((r) => r.id === user.id)?.quota?.completed,
    ).toBe(141 + Number(winners.has(user.id)));
  }
  expect(
    await prisma.auditEvent.count({
      where: {
        projectId: { in: f.picos.slice(1).map((p) => p.id) },
        action: "screening.decision.created",
      },
    }),
  ).toBe(84); // 40 two-copy groups + two successful reviews on the shared two-copy group.

  expect(
    await prisma.screeningAssignment.count({
      where: { citationId: { in: sharedIds }, status: "COMPLETED" },
    }),
  ).toBe(shared.length);
}, 120_000);
