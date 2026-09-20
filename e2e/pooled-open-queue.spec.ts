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
  test.setTimeout(180_000);
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
  } finally {
    await reviewerContext.close();
    await secondContext.close();
  }
});
