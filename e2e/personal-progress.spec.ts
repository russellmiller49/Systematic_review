import { test, expect, type APIRequestContext } from "@playwright/test";
import { PrismaClient } from "@prisma/client";
import { hashSync } from "bcryptjs";
import { signIn, signUp } from "./helpers";

const db = new PrismaClient();
test.afterAll(() => db.$disconnect());
async function post(request: APIRequestContext, path: string, data: unknown) {
  const response = await request.post(path, { data });
  expect(response.ok(), await response.text()).toBeTruthy();
  return (await response.json()).data;
}
async function put(request: APIRequestContext, path: string, data: unknown) {
  const response = await request.put(path, { data });
  expect(response.ok(), await response.text()).toBeTruthy();
  return (await response.json()).data;
}

test("personal counters use assigned targets, survive recovery/re-review, and follow scope/account changes", async ({
  page: reviewer,
  browser,
}) => {
  test.setTimeout(180000);
  if (
    !process.env.TEST_DATABASE_URL ||
    process.env.DATABASE_URL !== process.env.TEST_DATABASE_URL
  )
    throw new Error("Use the disposable progress database");
  const ownerContext = await browser.newContext();
  const owner = await ownerContext.newPage();
  try {
    const stamp = Date.now();
    await signUp(
      owner,
      "Synthetic progress owner",
      `progress-owner-${stamp}@test.local`,
    );
    const org = await post(owner.request, "/api/orgs", {
      name: `Progress fixture ${stamp}`,
    });
    const guideline = await post(
      owner.request,
      `/api/orgs/${org.id}/projects`,
      {
        title: "Synthetic progress guideline",
        reviewType: "GUIDELINE_EVIDENCE_REVIEW",
        isGuideline: true,
        reviewersPerCitation: 2,
      },
    );
    const picos = [];
    for (let i = 1; i <= 6; i++)
      picos.push(
        await post(owner.request, `/api/projects/${guideline.id}/subprojects`, {
          title: `Synthetic question ${i}`,
          researchQuestion: `Configured synthetic question ${i}`,
        }),
      );
    const pool = await put(
      owner.request,
      `/api/projects/${guideline.id}/screening/pool`,
      {
        name: "Synthetic PICO 2–6 pool",
        projectIds: picos.slice(1).map((p) => p.id),
      },
    );
    const users = [];
    for (let i = 0; i < 3; i++) {
      const user = await db.user.create({
        data: {
          name: `Synthetic progress reviewer ${i}`,
          email: `progress-reviewer-${i}-${stamp}@test.local`,
          passwordHash: hashSync("demo-password-123", 4),
        },
      });
      users.push(user);
      await post(owner.request, `/api/orgs/${org.id}/members`, {
        email: user.email,
        role: "MEMBER",
      });
      await post(owner.request, `/api/projects/${guideline.id}/members`, {
        email: user.email,
        roles: ["REVIEWER"],
      });
    }
    const groups = [];
    for (let i = 0; i < 2; i++) {
      const copies = [];
      for (const pico of [...picos.slice(1), picos[1]])
        copies.push(
          await db.citation.create({
            data: {
              projectId: pico.id,
              title: `Synthetic counter article ${i}`,
              normalizedTitle: `synthetic counter article ${i}`,
              doi: `10.9999/progress-${stamp}-${i}`,
              authors: [],
              abstract: "Synthetic complete abstract",
            },
          }),
        );
      groups.push(copies);
    }
    const stage = await db.screeningStage.findFirstOrThrow({
      where: { projectId: picos[0].id, type: "TITLE_ABSTRACT" },
    });
    await db.citation.create({
      data: {
        projectId: picos[0].id,
        title: "Synthetic individual counter article",
        normalizedTitle: "synthetic individual counter article",
        authors: [],
      },
    });
    await put(
      owner.request,
      `/api/projects/${picos[0].id}/screening/stages/${stage.id}/quotas`,
      { reviewers: [{ reviewerId: users[0]!.id, target: 2 }] },
    );
    const quotaUrl = `/api/projects/${guideline.id}/screening/pooled/quotas?poolId=${pool.id}`;
    await put(owner.request, quotaUrl, {
      reviewers: [
        { reviewerId: users[0]!.id, target: 400 },
        { reviewerId: users[1]!.id, target: 5 },
      ],
    });
    const url = `/projects/${guideline.id}/screening?queue=${encodeURIComponent(`pool:${pool.id}`)}`;
    const progress = reviewer.getByLabel("Your reviewer quota");
    await signIn(reviewer, users[0]!.email);
    await reviewer.goto(url);
    await expect(progress).toContainText("0 of 400 completed · 400 remaining");
    await expect(progress).toContainText("Available to review: 2");
    await expect(progress).toContainText("PICOs 2, 3, 4, 5, 6 together");
    await expect(progress.getByRole("progressbar")).toHaveAttribute(
      "aria-valuemax",
      "400",
    );
    await expect(
      reviewer.getByRole("tab", { name: "Admin view", exact: true }),
    ).toHaveCount(0);
    await progress.screenshot({
      path: "test-results/personal-progress-desktop.png",
    });
    await reviewer.setViewportSize({ width: 390, height: 844 });
    expect(
      await reviewer.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    ).toBe(true);
    await progress.screenshot({
      path: "test-results/personal-progress-mobile.png",
    });
    await reviewer
      .getByRole("region", { name: "Selected screening article" })
      .getByRole("button", { name: /Wrong population/ })
      .first()
      .click();
    await expect(progress).toContainText("1 of 400 completed · 399 remaining");
    const original = await db.screeningDecision.findMany({
      where: { reviewerId: users[0]!.id },
      select: { id: true, citationId: true },
    });
    expect(original).toHaveLength(6);
    const recovery = `/api/projects/${guideline.id}/screening/recovery`;
    const preview = await post(owner.request, `${recovery}/preview`, {
      poolId: pool.id,
      reviewerId: users[0]!.id,
      reason: "Synthetic personal-counter recovery check",
    });
    await post(owner.request, recovery, { token: preview.token });
    await reviewer.evaluate(() => window.dispatchEvent(new Event("focus")));
    await expect(progress).toContainText("0 of 400 completed · 400 remaining");
    expect(
      await db.screeningDecision.count({
        where: { reviewerId: users[0]!.id, withdrawnAt: { not: null } },
      }),
    ).toBe(6);
    await reviewer
      .getByRole("complementary", { name: "Article navigator" })
      .getByRole("button", { name: /Synthetic counter article 0/ })
      .click();
    await reviewer
      .getByRole("region", { name: "Selected screening article" })
      .getByRole("button", { name: /^Include/ })
      .click();
    await expect(progress).toContainText("1 of 400 completed · 399 remaining");
    const repeated = await db.screeningDecision.findMany({
      where: {
        reviewerId: users[0]!.id,
        citationId: { in: original.map((r) => r.citationId) },
      },
      select: { id: true },
    });
    expect(repeated.map((r) => r.id).sort()).toEqual(
      original.map((r) => r.id).sort(),
    );
    await reviewer
      .getByRole("region", { name: "Selected screening article" })
      .getByRole("button", { name: /^Include/ })
      .click();
    await expect(progress).toContainText("2 of 400 completed · 398 remaining");
    await reviewer.setViewportSize({ width: 1280, height: 900 });
    await expect(progress).toHaveAttribute("aria-busy", "false");
    await progress.screenshot({
      path: "test-results/personal-progress-desktop.png",
    });
    await reviewer.setViewportSize({ width: 390, height: 844 });
    expect(
      await reviewer.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    ).toBe(true);
    await progress.screenshot({
      path: "test-results/personal-progress-mobile.png",
    });
    await reviewer.getByRole("button", { name: /Screen PICO 1 only/ }).click();
    await expect(progress).toContainText("0 of 2 completed · 2 remaining");
    await reviewer.getByRole("tab", { name: "Full text", exact: true }).click();
    await expect(progress).toContainText("No personal target assigned");
    await expect(progress.getByLabel("Reviews remaining")).toHaveCount(0);
    await reviewer
      .getByRole("button", { name: /Screen PICOs 2, 3, 4, 5, 6 together/ })
      .click();
    await expect(progress).toContainText("2 of 400 completed · 398 remaining");
    await put(owner.request, quotaUrl, {
      reviewers: [{ reviewerId: users[0]!.id, target: 0 }],
    });
    await reviewer.evaluate(() => window.dispatchEvent(new Event("focus")));
    await expect(progress).toContainText("2 completed · 0 remaining");
    await expect(progress).toContainText("New reviews are paused");
    await expect(progress.getByRole("progressbar")).toHaveCount(0);
    await put(owner.request, quotaUrl, {
      reviewers: [{ reviewerId: users[0]!.id, target: 1 }],
    });
    await reviewer.evaluate(() => window.dispatchEvent(new Event("focus")));
    await expect(progress).toContainText("2 of 1 completed · 0 remaining");
    await expect(progress).toContainText(
      "Completed reviews exceed the current target",
    );
    await expect(progress.getByRole("progressbar")).toHaveAttribute(
      "aria-valuenow",
      "1",
    );
    await put(owner.request, quotaUrl, {
      reviewers: [{ reviewerId: users[0]!.id, target: null }],
    });
    await reviewer.evaluate(() => window.dispatchEvent(new Event("focus")));
    await expect(progress).toContainText("2 reviews completed");
    await expect(progress).toContainText("No numerical target set");
    await expect(progress.getByLabel("Reviews remaining")).toHaveCount(0);
    await signIn(reviewer, users[1]!.email);
    await reviewer.goto(url);
    await expect(progress).toContainText("0 of 5 completed · 5 remaining");
    await signIn(reviewer, users[2]!.email);
    await reviewer.goto(url);
    await expect(progress).toContainText("No personal target assigned");
    await expect(progress.getByLabel("Reviews completed")).toHaveCount(0);
    await owner.goto(url);
    await owner.getByRole("tab", { name: "Admin view", exact: true }).click();
    await expect(owner.getByLabel("Your reviewer quota")).toHaveCount(0);
  } finally {
    await ownerContext.close();
  }
});

test("loading and failed refresh never show invented or silently stale personal counts", async ({
  page,
}) => {
  test.setTimeout(90000);
  const stamp = Date.now();
  await signUp(
    page,
    "Synthetic loading reviewer",
    `progress-loading-${stamp}@test.local`,
  );
  const org = await post(page.request, "/api/orgs", {
    name: `Loading fixture ${stamp}`,
  });
  const project = await post(page.request, `/api/orgs/${org.id}/projects`, {
    title: "Synthetic loading project",
    reviewType: "SYSTEMATIC_REVIEW",
    reviewersPerCitation: 2,
  });
  const stages = (
    await (
      await page.request.get(`/api/projects/${project.id}/screening/stages`)
    ).json()
  ).data;
  const user = await db.user.findUniqueOrThrow({
    where: { email: `progress-loading-${stamp}@test.local` },
  });
  await put(
    page.request,
    `/api/projects/${project.id}/screening/stages/${stages[0].id}/quotas`,
    { reviewers: [{ reviewerId: user.id, target: 13 }] },
  );
  let release!: () => void;
  const barrier = new Promise<void>((resolve) => (release = resolve));
  await page.route("**/navigator?**", async (route) => {
    await barrier;
    await route.continue();
  });
  await page.goto(`/projects/${project.id}/screening`);
  const progress = page.getByLabel("Your reviewer quota");
  await expect(progress).toContainText("Loading your screening progress");
  await expect(progress.getByLabel("Reviews completed")).toHaveCount(0);
  release();
  await expect(progress).toContainText("0 of 13 completed · 13 remaining");
  await page.unroute("**/navigator?**");
  await page.route("**/navigator?**", (route) =>
    route.fulfill({
      status: 503,
      contentType: "application/json",
      body: JSON.stringify({
        error: {
          code: "UNAVAILABLE",
          message: "Synthetic temporary queue failure",
        },
      }),
    }),
  );
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect(progress).toContainText(
    "Personal progress could not be refreshed",
  );
  await expect(progress.getByLabel("Reviews completed")).toHaveCount(0);
  await page.unroute("**/navigator?**");
  await page.getByRole("button", { name: "Retry", exact: true }).click();
  await expect(progress).toContainText("0 of 13 completed · 13 remaining");
});
