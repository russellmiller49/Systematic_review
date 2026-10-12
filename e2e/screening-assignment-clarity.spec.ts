import { test, expect, type APIRequestContext } from "@playwright/test";
import { PrismaClient } from "@prisma/client";
import { hashSync } from "bcryptjs";
import { signUp } from "./helpers";

const db = new PrismaClient();
test.afterAll(() => db.$disconnect());
async function post(request: APIRequestContext, path: string, data: unknown) {
  const response = await request.post(path, { data });
  expect(response.ok(), await response.text()).toBeTruthy();
  return (await response.json()).data;
}

test("configured scope, explicit entry, independent PICO switches, admin inspection and restrictive reviewer journey", async ({
  page: owner,
  browser,
}) => {
  test.setTimeout(180000);
  if (!process.env.TEST_DATABASE_URL || process.env.DATABASE_URL !== process.env.TEST_DATABASE_URL)
    throw new Error("Use isolated test database");
  const stamp = Date.now();
  await signUp(owner, "Synthetic owner", `scope-owner-${stamp}@test.local`);
  const org = await post(owner.request, "/api/orgs", { name: `Scope fixture ${stamp}` });
  const guideline = await post(owner.request, `/api/orgs/${org.id}/projects`, {
    title: "Synthetic scope guideline",
    reviewType: "GUIDELINE_EVIDENCE_REVIEW",
    isGuideline: true,
    reviewersPerCitation: 2,
  });
  const picos = [];
  for (let i = 1; i <= 4; i++)
    picos.push(
      await post(owner.request, `/api/projects/${guideline.id}/subprojects`, {
        title: `Question ${i}`,
        researchQuestion: `Configured question ${i}`,
      }),
    );
  for (const [i, pico] of picos.entries()) {
    const response = await owner.request.patch(`/api/projects/${pico.id}/protocol`, {
      data: {
        population: `Configured population ${i + 1}`,
        studyDesigns: [`Configured design ${i + 1}`],
      },
    });
    expect(response.ok(), await response.text()).toBeTruthy();
    await post(owner.request, `/api/projects/${pico.id}/protocol/criteria`, {
      type: "INCLUSION",
      text: `Configured eligibility exception ${i + 1}`,
    });
    await db.citation.create({
      data: {
        projectId: pico.id,
        title: i < 2 ? `Individual abstract ${i + 1}` : "Shared abstract",
        normalizedTitle: i < 2 ? `individual abstract ${i + 1}` : "shared abstract",
        abstract: "Synthetic complete abstract",
        authors: [],
        year: 2026,
        doi: i < 2 ? null : "10.1234/synthetic-shared",
      },
    });
  }
  const poolResponse = await owner.request.put(`/api/projects/${guideline.id}/screening/pool`, {
    data: { name: "Saved combined scope", projectIds: picos.slice(2).map((p) => p.id) },
  });
  expect(poolResponse.ok(), await poolResponse.text()).toBeTruthy();
  const pool = (await poolResponse.json()).data;
  // This was ignored before the repair: the presence of a pool always won.
  await owner.goto(
    `/projects/${guideline.id}/screening?queue=${encodeURIComponent(`pico:${picos[0].id}`)}`,
  );
  await expect(owner.getByText("Individual PICO", { exact: true })).toBeVisible();
  await expect(owner.getByRole("button", { name: /Screen PICO 1 only/ })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await expect(owner.getByRole("region", { name: "Screening scope" })).toContainText(
    "Configured population 1",
  );
  // Switching individual queues previously retained the first project's stage ID.
  await owner.getByRole("button", { name: /Screen PICO 2 only/ }).click();
  await expect(owner.getByRole("region", { name: "Screening scope" })).toContainText(
    "Configured population 2",
  );
  const secondStages = await db.screeningStage.findMany({
    where: { projectId: picos[1].id, type: "TITLE_ABSTRACT" },
  });
  const response = owner.waitForResponse(
    (r) => r.url().includes(`/stages/${secondStages[0]!.id}/navigator`) && r.status() === 200,
  );
  await owner.getByRole("tab", { name: "My screening", exact: true }).click();
  // A cached request may already have completed; reload exercises the explicit entry URL too.
  await owner.reload();
  await response;
  await expect(
    owner.getByText("No personal target or active fixed assignment", { exact: false }),
  ).toBeVisible();
  await owner.getByRole("button", { name: /Screen PICOs 3, 4 together/ }).click();
  const scope = owner.getByRole("region", { name: "Screening scope" });
  await expect(scope).toContainText("Configured population 3");
  await expect(scope).toContainText("Configured population 4");
  await expect(scope).toContainText("ANY PICO");
  await scope.getByText("Question definitions and eligibility", { exact: false }).first().focus();
  await owner.keyboard.press("Space");
  await expect(
    scope.getByText("Configured eligibility exception 3", { exact: false }),
  ).toBeVisible();
  await expect(owner.getByRole("tab", { name: "Admin view", exact: true })).toBeVisible();
  await owner.getByRole("tab", { name: "Admin view", exact: true }).click();
  await expect(owner.getByText("Pool health", { exact: true })).toBeVisible();
  await expect(owner.getByRole("heading", { name: "Shared abstract", exact: true })).toBeVisible();
  await expect(owner.getByRole("button", { name: "Include", exact: true })).toHaveCount(0);
  await expect(owner.getByLabel("Your reviewer quota")).toHaveCount(0);
  await owner.evaluate(() => window.scrollTo(0, 0));
  await owner.screenshot({ path: "test-results/scope-admin-desktop.png", fullPage: true });
  const decisionCount = await db.screeningDecision.count({
    where: { stage: { project: { parentProjectId: guideline.id } } },
  });
  await owner.keyboard.press("i");
  expect(
    await db.screeningDecision.count({
      where: { stage: { project: { parentProjectId: guideline.id } } },
    }),
  ).toBe(decisionCount);

  const reviewerContext = await browser.newContext();
  const reviewer = await reviewerContext.newPage();
  try {
    const email = `scope-reviewer-${stamp}@test.local`;
    await signUp(reviewer, "Synthetic reviewer", email);
    await post(owner.request, `/api/orgs/${org.id}/members`, { email, role: "MEMBER" });
    await post(owner.request, `/api/projects/${guideline.id}/members`, {
      email,
      roles: ["REVIEWER"],
    });
    const user = await db.user.findUniqueOrThrow({ where: { email } });
    const quota = await owner.request.put(
      `/api/projects/${guideline.id}/screening/pooled/quotas?poolId=${pool.id}`,
      { data: { reviewers: [{ reviewerId: user.id, target: 400 }] } },
    );
    expect(quota.ok(), await quota.text()).toBeTruthy();
    await reviewer.goto(`/projects/${picos[2].id}/screening`);
    await reviewer.getByRole("link", { name: "Open combined pool", exact: true }).click();
    await expect(reviewer.getByRole("region", { name: "Screening scope" })).toContainText(
      "Configured population 4",
    );
    await expect(reviewer.getByRole("tab", { name: "Admin view", exact: true })).toHaveCount(0);
    await expect(reviewer.getByLabel("Your reviewer quota")).toContainText(
      "Target: 400 · Completed: 0 · Remaining: 400 · Available to review: 1",
    );
    await reviewer.setViewportSize({ width: 390, height: 844 });
    expect(
      await reviewer.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
    await reviewer.screenshot({ path: "test-results/scope-reviewer-mobile.png", fullPage: true });
    await reviewer.getByRole("heading", { name: "Shared abstract", exact: true }).click();
    await reviewer.keyboard.press("i");
    await expect(reviewer.getByLabel("Your reviewer quota")).toContainText(
      "Completed: 1 · Remaining: 399",
    );
    await reviewer.getByLabel("Filter article status").selectOption("MY_REVIEWED");
    await expect(
      reviewer.getByText("Imported in · provenance only", { exact: true }),
    ).toBeVisible();
    await expect(
      reviewer.getByText("Current scope: PICOs 3, 4 together", { exact: false }),
    ).toBeVisible();
    await reviewer.goto(`/projects/${guideline.id}`);
    await expect(
      reviewer.getByRole("link", { name: /Screen PICOs 3, 4 together/ }).first(),
    ).toBeVisible();
    await reviewer.goto(`/projects/${guideline.id}/screening?queue=pool%3Aremoved`);
    await expect(
      reviewer.getByText("The queue in this link is no longer configured", { exact: false }),
    ).toBeVisible();
    await expect(reviewer.getByRole("region", { name: "Screening scope" })).toHaveCount(0);
    const scopeRead = await reviewer.request.get(
      `/api/projects/${guideline.id}/screening/scope?poolId=${pool.id}`,
    );
    expect(scopeRead.ok()).toBe(true);
    const adminRead = await reviewer.request.get(
      `/api/projects/${guideline.id}/screening/pooled?poolId=${pool.id}&status=ALL`,
    );
    expect(adminRead.status()).toBe(403);
  } finally {
    await reviewerContext.close();
  }
});

test("invitation mismatch keeps exact address authorization and can switch accounts with the link preserved", async ({
  page,
}) => {
  test.setTimeout(120000);
  const stamp = Date.now();
  const invitedEmail = `invited-${stamp}@institution.test`;
  await signUp(page, "Invitation owner", `owner-${stamp}@other-institution.test`);
  const org = await post(page.request, "/api/orgs", { name: `Invitation fixture ${stamp}` });
  const project = await post(page.request, `/api/orgs/${org.id}/projects`, {
    title: "Invitation fixture",
    reviewType: "SYSTEMATIC_REVIEW",
    reviewersPerCitation: 2,
  });
  await db.user.create({
    data: {
      name: "Invited account",
      email: invitedEmail,
      passwordHash: hashSync("demo-password-123", 4),
    },
  });
  const invitation = await post(page.request, `/api/projects/${project.id}/invitations`, {
    email: invitedEmail.toUpperCase(),
    roles: ["REVIEWER"],
  });
  const callback = `/invitations/${encodeURIComponent(invitation.token)}`;
  await page.goto(callback);
  await page.getByRole("button", { name: "Accept invitation", exact: true }).click();
  await expect(
    page.getByText("This invitation was issued to a different email address", { exact: true }),
  ).toBeVisible();
  expect(
    await db.projectInvitation.findUniqueOrThrow({ where: { id: invitation.id } }),
  ).toMatchObject({ acceptedAt: null });
  await page.getByRole("button", { name: "Sign in with a different account", exact: true }).click();
  await page.waitForURL(/\/sign-in\?/);
  expect(new URL(page.url()).searchParams.get("callbackUrl")).toBe(callback);
  await page.fill("#email", invitedEmail);
  await page.fill("#password", "demo-password-123");
  await page.getByRole("button", { name: /sign in/i }).click();
  await page.waitForURL(new RegExp(`/invitations/`));
  await page.getByRole("button", { name: "Accept invitation", exact: true }).click();
  await page.waitForURL(`/projects/${project.id}`);
  const invitedUser = await db.user.findUniqueOrThrow({ where: { email: invitedEmail } });
  expect(
    await db.projectMember.findUniqueOrThrow({
      where: { projectId_userId: { projectId: project.id, userId: invitedUser.id } },
    }),
  ).toMatchObject({ roles: ["REVIEWER"], status: "ACTIVE" });
});
