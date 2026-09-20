import {
  test,
  expect,
  type APIRequestContext,
  type Page,
} from "@playwright/test";
import { PrismaClient } from "@prisma/client";
import { signUp, expectNoErrorOverlay } from "./helpers";

const db = new PrismaClient();
test.afterAll(async () => {
  await db.$disconnect();
});
async function post(request: APIRequestContext, path: string, data: unknown) {
  const response = await request.post(path, { data });
  expect(response.ok(), await response.text()).toBeTruthy();
  return (await response.json()).data;
}
async function get(request: APIRequestContext, path: string) {
  const response = await request.get(path);
  expect(response.ok(), await response.text()).toBeTruthy();
  return (await response.json()).data;
}
async function importPool(request: APIRequestContext, projectId: string) {
  const source = await post(
    request,
    `/api/projects/${projectId}/import-sources`,
    { name: "Open queue test", type: "DATABASE" },
  );
  const response = await request.post(`/api/projects/${projectId}/imports`, {
    multipart: {
      sourceId: source.id,
      format: "RIS",
      file: {
        name: "pool.ris",
        mimeType: "text/plain",
        buffer: Buffer.from(
          Array.from(
            { length: 65 },
            (_, i) =>
              `TY  - JOUR\nTI  - Open abstract ${String(i + 1).padStart(3, "0")}\nAU  - Queue, Reviewer\nPY  - 2024\nDO  - 10.5678/open-${i + 1}\nAB  - Complete searchable abstract ${i + 1}.\nER  - `,
          ).join("\n"),
        ),
      },
    },
  });
  expect(response.ok(), await response.text()).toBeTruthy();
  await post(
    request,
    `/api/projects/${projectId}/imports/${(await response.json()).data.id}/commit`,
    {},
  );
}
async function choose(page: Page, number: string) {
  const article = page.getByRole("region", {
    name: "Selected screening article",
  });
  const navigator = page.getByRole("complementary", {
    name: "Article navigator",
  });
  await navigator
    .getByRole("button", { name: new RegExp(`Open abstract ${number}`) })
    .click();
  await expect(
    article.getByRole("heading", {
      name: `Open abstract ${number}`,
      exact: true,
    }),
  ).toBeVisible();
  return article;
}

test("pooled reviewer freely navigates, skips, screens a non-first abstract, and recovers from a stale final slot", async ({
  page: owner,
  browser,
}) => {
  test.setTimeout(240_000);
  if (
    !process.env.TEST_DATABASE_URL ||
    process.env.DATABASE_URL !== process.env.TEST_DATABASE_URL
  )
    throw new Error(
      "Run with playwright.quota.config.ts against the isolated test database",
    );
  const stamp = Date.now();
  const reviewerContext = await browser.newContext();
  const secondContext = await browser.newContext();
  const reviewer = await reviewerContext.newPage();
  const second = await secondContext.newPage();
  try {
    await signUp(owner, "Open queue owner", `pool-owner-${stamp}@test.local`);
    await signUp(
      reviewer,
      "Open queue reviewer",
      `pool-reviewer-${stamp}@test.local`,
    );
    await signUp(
      second,
      "Second pool reviewer",
      `pool-second-${stamp}@test.local`,
    );
    const org = await post(owner.request, "/api/orgs", {
      name: `Pooled browser test ${stamp}`,
    });
    const guideline = await post(
      owner.request,
      `/api/orgs/${org.id}/projects`,
      {
        title: "Guideline open screening",
        reviewType: "GUIDELINE_EVIDENCE_REVIEW",
        isGuideline: true,
        reviewersPerCitation: 2,
      },
    );
    for (const email of [
      `pool-reviewer-${stamp}@test.local`,
      `pool-second-${stamp}@test.local`,
    ]) {
      await post(owner.request, `/api/orgs/${org.id}/members`, {
        email,
        role: "MEMBER",
      });
      await post(owner.request, `/api/projects/${guideline.id}/members`, {
        email,
        roles: ["REVIEWER"],
      });
    }
    const picos = [];
    for (let i = 1; i <= 4; i++)
      picos.push(
        await post(owner.request, `/api/projects/${guideline.id}/subprojects`, {
          title: `PICO ${i}`,
          researchQuestion: `Question ${i}`,
        }),
      );
    for (const pico of picos.slice(1)) await importPool(owner.request, pico.id);
    const response = await owner.request.put(
      `/api/projects/${guideline.id}/screening/pool`,
      {
        data: {
          name: "PICO 2–4 combined",
          projectIds: picos.slice(1).map((p) => p.id),
        },
      },
    );
    expect(response.ok(), await response.text()).toBeTruthy();
    const pool = (await response.json()).data;
    const endpoint = `/api/projects/${guideline.id}/screening/pooled`;
    const allMembers = await get(
      owner.request,
      `/api/projects/${guideline.id}/members`,
    );
    const quotas = await owner.request.put(
      `${endpoint}/quotas?poolId=${pool.id}`,
      {
        data: {
          reviewers: allMembers.map((m: { user: { id: string } }) => ({
            reviewerId: m.user.id,
            target: 3,
          })),
        },
      },
    );
    expect(quotas.ok(), await quotas.text()).toBeTruthy();
    const projectIds = picos.slice(1).map((p) => p.id);
    const reviewerId = (
      await db.user.findUniqueOrThrow({
        where: { email: `pool-reviewer-${stamp}@test.local` },
      })
    ).id;
    const auditBefore = await db.auditEvent.count({
      where: { projectId: { in: projectIds } },
    });
    await reviewer.goto(`/projects/${guideline.id}/screening`);
    const navigator = reviewer.getByRole("complementary", {
      name: "Article navigator",
    });
    const article = reviewer.getByRole("region", {
      name: "Selected screening article",
    });
    const progress = reviewer.getByLabel("Your reviewer quota");
    await expect(progress).toContainText(
      "Target: 3 · Completed: 0 · Remaining: 3 · Available to review: 65",
    );
    await expect(navigator.getByRole("listitem")).toHaveCount(50);
    await expect(
      reviewer.getByRole("button", { name: "Reviewer quotas", exact: true }),
    ).toHaveCount(0);
    await expect(
      reviewer.getByText("Pool health", { exact: true }),
    ).toHaveCount(0);

    // Skip with arrows, cross page boundaries, and search the logical corpus.
    await choose(reviewer, "001");
    await reviewer.keyboard.press("ArrowRight");
    await expect(
      article.getByRole("heading", { name: "Open abstract 002" }),
    ).toBeVisible();
    await choose(reviewer, "050");
    await article
      .getByRole("button", { name: "Next article", exact: true })
      .click();
    await expect(
      article.getByRole("heading", { name: "Open abstract 051" }),
    ).toBeVisible();
    await expect(navigator.getByRole("listitem")).toHaveCount(15);
    await article
      .getByRole("button", { name: "Previous article", exact: true })
      .click();
    await expect(
      article.getByRole("heading", { name: "Open abstract 050" }),
    ).toBeVisible();
    await navigator
      .getByLabel("Search pooled articles")
      .fill("10.5678/open-65");
    await navigator
      .getByRole("button", { name: "Search articles", exact: true })
      .click();
    await expect(navigator.getByRole("listitem")).toHaveCount(1);
    await expect(
      article.getByRole("heading", { name: "Open abstract 065" }),
    ).toBeVisible();
    await navigator
      .getByRole("button", { name: "Clear article search" })
      .click();
    await expect(navigator.getByRole("listitem")).toHaveCount(50);
    expect(
      await db.screeningAssignment.count({
        where: { citation: { projectId: { in: projectIds } } },
      }),
    ).toBe(0);
    expect(
      await db.auditEvent.count({ where: { projectId: { in: projectIds } } }),
    ).toBe(auditBefore);

    await choose(reviewer, "037");
    await expect(article).toContainText("PICO 2 · PICO 2");
    await expect(article).toContainText("PICO 3 · PICO 3");
    await expect(article).toContainText("PICO 4 · PICO 4");
    await article.getByRole("button", { name: /^Note/ }).click();
    await article
      .getByLabel("Reviewer note")
      .fill("Review eligibility with the group");
    await reviewer.evaluate(() => window.scrollTo(0, 0));
    await reviewer.screenshot({
      path: "test-results/pooled-open-desktop.png",
      fullPage: true,
    });
    await article.getByRole("button", { name: /^Maybe/ }).click();
    await expect(progress).toContainText(
      "Completed: 1 · Remaining: 2 · Available to review: 64",
    );
    await expect(
      navigator.getByRole("button", { name: /Open abstract 037/ }),
    ).toHaveCount(0);
    await expect(
      navigator.getByRole("button", { name: /Open abstract 001/ }),
    ).toBeVisible();
    const linked = await db.screeningDecision.findMany({
      where: { reviewerId, citation: { projectId: { in: projectIds } } },
    });
    expect(linked).toHaveLength(3);
    expect(
      linked.every(
        (d) =>
          d.decision === "MAYBE" &&
          d.notes === "Review eligibility with the group",
      ),
    ).toBe(true);
    expect(
      await db.screeningAssignment.count({
        where: {
          citation: {
            projectId: { in: projectIds },
            title: "Open abstract 001",
          },
        },
      }),
    ).toBe(0);
    await navigator
      .getByLabel("Filter article status")
      .selectOption("MY_REVIEWED");
    await expect(article.getByLabel("Reviewer note")).toHaveValue(
      "Review eligibility with the group",
    );
    await article.getByRole("button", { name: /^Include/ }).click();
    await expect(progress).toContainText("Completed: 1 · Remaining: 2");
    await expect(article).toContainText("Your decision: include");
    await navigator
      .getByLabel("Filter article status")
      .selectOption("AVAILABLE");

    // Two other eligible reviewers settle the selected abstract after this browser loads it.
    const otherQueue = await get(
      owner.request,
      `${endpoint}?poolId=${pool.id}`,
    );
    const stale = otherQueue.items.find(
      (item: { citation: { title: string } }) =>
        item.citation.title === "Open abstract 001",
    );
    const body = {
      poolId: pool.id,
      citationIds: stale.citationIds,
      decision: "INCLUDE",
    };
    await post(owner.request, endpoint, body);
    await reviewer
      .getByRole("button", { name: "Refresh", exact: true })
      .click();
    await choose(reviewer, "001");
    await expect(article).toContainText("1 of 2 required reviews submitted");
    await post(second.request, endpoint, body);
    await article.getByRole("button", { name: /^Include/ }).click();
    await expect(
      reviewer.getByText(
        "This abstract has just received all required reviews. Choose another abstract.",
        { exact: true },
      ),
    ).toBeVisible();
    await expect(
      navigator.getByRole("button", { name: /Open abstract 001/ }),
    ).toHaveCount(0);
    await expect(progress).toContainText("Completed: 1 · Remaining: 2");
    expect(
      await db.screeningAssignment.count({
        where: { citationId: { in: stale.citationIds }, reviewerId },
      }),
    ).toBe(0);
    await reviewer.setViewportSize({ width: 390, height: 844 });
    await reviewer.evaluate(() => window.scrollTo(0, 0));
    await reviewer.screenshot({
      path: "test-results/pooled-open-mobile.png",
      fullPage: true,
    });
    expect(
      await navigator.evaluate(
        (element) => element.getBoundingClientRect().height,
      ),
    ).toBeLessThan(500);
    expect(
      await reviewer.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    ).toBe(true);
    await expectNoErrorOverlay(reviewer);

    // Final history stays readable while both UI and API forbid a revision.
    const reviewedIds = linked.map((d) => d.citationId);
    await post(second.request, endpoint, {
      poolId: pool.id,
      citationIds: reviewedIds,
      decision: "INCLUDE",
    });
    await reviewer.setViewportSize({ width: 1280, height: 900 });
    await navigator
      .getByLabel("Filter article status")
      .selectOption("MY_REVIEWED");
    await expect(article).toContainText("Screening decisions are locked");
    await expect(article).toContainText("Review eligibility with the group");
    await expect(article.getByRole("button", { name: /^Maybe/ })).toHaveCount(
      0,
    );
    const locked = await reviewer.request.post(endpoint, {
      data: { poolId: pool.id, citationIds: reviewedIds, decision: "MAYBE" },
    });
    expect(locked.ok()).toBe(false);
    await navigator
      .getByLabel("Filter article status")
      .selectOption("AVAILABLE");
    await choose(reviewer, "002");
    await reviewer.keyboard.press("1");
    await expect(progress).toContainText("Completed: 2 · Remaining: 1");
    const quick = await db.screeningDecision.findMany({
      where: {
        reviewerId,
        citation: { projectId: { in: projectIds }, title: "Open abstract 002" },
      },
      include: { exclusionReason: true },
    });
    expect(quick).toHaveLength(3);
    expect(
      quick.every(
        (d) => d.decision === "EXCLUDE" && d.exclusionReason !== null,
      ),
    ).toBe(true);

    // PICO 1 shares the navigator and controls, but keeps its own corpus and quota.
    const pico1 = picos[0]!;
    await importPool(owner.request, pico1.id);
    const stages = await get(
      owner.request,
      `/api/projects/${pico1.id}/screening/stages`,
    );
    const stage = stages.find(
      (s: { type: string }) => s.type === "TITLE_ABSTRACT",
    );
    const ordinary = `/api/projects/${pico1.id}/screening/stages/${stage.id}`;
    const quotaResponse = await owner.request.put(`${ordinary}/quotas`, {
      data: {
        reviewers: allMembers.map((m: { user: { id: string } }) => ({
          reviewerId: m.user.id,
          target: 4,
        })),
      },
    });
    expect(quotaResponse.ok(), await quotaResponse.text()).toBeTruthy();
    const ordinaryBefore = await db.auditEvent.count({
      where: { projectId: pico1.id },
    });
    await reviewer.goto(`/projects/${pico1.id}/screening`);
    await expect(progress).toContainText(
      "Target: 4 · Completed: 0 · Remaining: 4",
    );
    await expect(navigator.getByRole("listitem")).toHaveCount(50);
    await choose(reviewer, "037");
    await reviewer.keyboard.press("ArrowRight");
    await expect(
      article.getByRole("heading", { name: "Open abstract 038", exact: true }),
    ).toBeVisible();
    await article
      .getByRole("button", { name: "Previous article", exact: true })
      .click();
    await expect(
      article.getByRole("heading", { name: "Open abstract 037", exact: true }),
    ).toBeVisible();
    await navigator.getByRole("button", { name: "Next", exact: true }).click();
    await expect(navigator.getByRole("listitem")).toHaveCount(15);
    await choose(reviewer, "060");
    await navigator
      .getByLabel("Search available and reviewed articles")
      .fill("Open abstract 065");
    await navigator
      .getByRole("button", { name: "Search articles", exact: true })
      .click();
    await expect(navigator.getByRole("listitem")).toHaveCount(1);
    await navigator
      .getByRole("button", { name: "Clear article search" })
      .click();
    await expect(navigator.getByRole("listitem")).toHaveCount(50);
    expect(
      await db.screeningAssignment.count({
        where: { citation: { projectId: pico1.id } },
      }),
    ).toBe(0);
    expect(await db.auditEvent.count({ where: { projectId: pico1.id } })).toBe(
      ordinaryBefore,
    );
    await choose(reviewer, "037");
    await reviewer.keyboard.press("n");
    await article.getByLabel("Reviewer note").fill("Independent PICO 1 note");
    await reviewer.keyboard.press("Escape");
    await reviewer.keyboard.press("m");
    await expect(progress).toContainText("Completed: 1 · Remaining: 3");
    await navigator.getByLabel("Filter article status").selectOption("DECIDED");
    await expect(article.getByLabel("Reviewer note")).toHaveValue(
      "Independent PICO 1 note",
    );
    await article.getByRole("button", { name: /^Include/ }).click();
    await expect(article).toContainText("Your decision: include");
    await expect(progress).toContainText("Completed: 1 · Remaining: 3");
    await navigator
      .getByLabel("Filter article status")
      .selectOption("UNDECIDED");
    await choose(reviewer, "038");
    await reviewer.keyboard.press("1");
    await expect(progress).toContainText("Completed: 2 · Remaining: 2");
    await choose(reviewer, "039");
    await article.getByRole("button", { name: /^Exclude / }).click();
    const exclusion = reviewer.getByRole("dialog");
    await exclusion.getByLabel("Note (optional)").fill("PICO 1 reason note");
    await exclusion
      .getByLabel("Exclusion reason subgroup")
      .selectOption({ index: 1 });
    await expect(progress).toContainText("Completed: 3 · Remaining: 1");
    const individualQueue = await get(owner.request, `${ordinary}/navigator`);
    const shared = individualQueue.items.find(
      (i: { citation: { title: string } }) =>
        i.citation.title === "Open abstract 040",
    );
    await post(owner.request, `${ordinary}/decisions`, {
      citationId: shared.citation.id,
      decision: "INCLUDE",
    });
    await reviewer.reload();
    await choose(reviewer, "040");
    await expect(article).toContainText("1 of 2 required reviews submitted");
    await reviewer.keyboard.press("i");
    await expect(progress).toContainText("Completed: 4 · Remaining: 0");
    const individualDecisions = await db.screeningDecision.findMany({
      where: { reviewerId, citation: { projectId: pico1.id } },
      include: { citation: true, exclusionReason: true },
    });
    expect(individualDecisions).toHaveLength(4);
    expect(
      individualDecisions.find((d) => d.citation.title === "Open abstract 037"),
    ).toMatchObject({ decision: "INCLUDE", notes: "Independent PICO 1 note" });
    expect(
      individualDecisions.find((d) => d.citation.title === "Open abstract 039"),
    ).toMatchObject({
      decision: "EXCLUDE",
      notes: "PICO 1 reason note",
      exclusionReason: expect.any(Object),
    });
    expect(
      (await get(reviewer.request, `${endpoint}?poolId=${pool.id}`)).quota
        .completed,
    ).toBe(2);
    await owner.goto(`/projects/${pico1.id}/screening`);
    await owner.getByRole("tab", { name: "Admin view", exact: true }).click();
    await expect(owner.getByLabel("Filter screening status")).toBeVisible();
    await owner.getByLabel("Search article titles").fill("Open abstract 040");
    await owner.getByRole("button", { name: "Search", exact: true }).click();
    await expect(
      owner.getByText("Open abstract 040", { exact: true }),
    ).toBeVisible();
    await expectNoErrorOverlay(reviewer);
    await expectNoErrorOverlay(owner);
  } finally {
    await reviewerContext.close();
    await secondContext.close();
  }
});
