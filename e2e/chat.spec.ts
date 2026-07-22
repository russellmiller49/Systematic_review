import { test, expect, type Browser } from "@playwright/test";
import { signIn, openDemoProject, expectNoErrorOverlay, DEMO } from "./helpers";

// Two-user chat flow on the seeded project: seeded channels render with unread badges,
// polling delivers a new message + mention across sessions, threads work, the mention
// lands in the bell, and the assignee completes a seeded assignment.

async function newSession(browser: Browser, email: string) {
  const context = await browser.newContext();
  const page = await context.newPage();
  await signIn(page, email);
  return { context, page };
}

test("seeded chat renders; polling delivers messages, mentions, and assignments", async ({
  browser,
}) => {
  test.setTimeout(120_000);
  const owner = await newSession(browser, DEMO.owner);
  const reviewer = await newSession(browser, DEMO.reviewer1);

  // Reviewer1 (seeded with unread): sidebar badge + channel list + seeded content.
  await openDemoProject(reviewer.page);
  const chatLink = reviewer.page.getByRole("link", { name: /Team chat/ });
  await expect(chatLink).toBeVisible();
  await chatLink.click();
  await expect(reviewer.page.getByRole("heading", { name: "Team chat" })).toBeVisible();
  await expect(reviewer.page.getByText("Welcome to the project channel!")).toBeVisible({
    timeout: 30_000,
  });
  await expect(reviewer.page.getByText("@Ravi Reviewer").first()).toBeVisible();

  // Seeded topic channel thread.
  await reviewer.page.getByRole("button", { name: /screening-questions/ }).click();
  await expect(
    reviewer.page.getByText("If an abstract only reports 6-month FEV1", { exact: false }),
  ).toBeVisible();
  await reviewer.page.getByRole("button", { name: /1 reply/ }).click();
  await expect(
    reviewer.page.getByText("include at T/A whenever the timepoint is ambiguous", { exact: false }),
  ).toBeVisible();

  // Owner posts a mention into #general; reviewer's 4s poll delivers it.
  await openDemoProject(owner.page);
  await owner.page.getByRole("link", { name: /Team chat/ }).click();
  await expect(owner.page.getByText("Welcome to the project channel!")).toBeVisible({
    timeout: 30_000,
  });
  await owner.page.getByPlaceholder(/Message #general/).click();
  await owner.page.getByRole("button", { name: "Mention" }).click();
  await owner.page.getByRole("button", { name: "Ravi Reviewer" }).click();
  await owner.page.getByPlaceholder(/Message #general/).type("can you check batch 3 today?");
  await owner.page.getByRole("button", { name: "Send" }).click();
  await expect(owner.page.getByText("can you check batch 3 today?")).toBeVisible();

  await reviewer.page.getByRole("button", { name: /general/ }).first().click();
  await expect(reviewer.page.getByText("can you check batch 3 today?")).toBeVisible({
    timeout: 20_000,
  });

  // The mention reached reviewer1's bell.
  await reviewer.page.getByRole("button", { name: /Notifications/ }).click();
  await expect(reviewer.page.getByText(/mentioned you/).first()).toBeVisible({ timeout: 20_000 });
  await reviewer.page.keyboard.press("Escape");

  // Assignments tab: reviewer1 completes the seeded whole-team assignment.
  await reviewer.page.getByRole("tab", { name: "Assignments" }).click();
  await expect(
    reviewer.page.getByText("Please finish your remaining full-text decisions", { exact: false }).first(),
  ).toBeVisible();
  await reviewer.page.getByRole("button", { name: "Mark done" }).first().click();
  await expect(reviewer.page.getByText("Marked done")).toBeVisible();

  // Owner (admin) sees everyone's tasks including Rosa's completed one.
  await owner.page.getByRole("tab", { name: "Assignments" }).click();
  await expect(owner.page.getByText("Everyone's")).toBeVisible();
  await owner.page.getByRole("button", { name: "Done", exact: true }).click(); // status filter chip
  await expect(owner.page.getByText("Rosa Reviewer").first()).toBeVisible();

  await expectNoErrorOverlay(owner.page);
  await expectNoErrorOverlay(reviewer.page);
  await owner.context.close();
  await reviewer.context.close();
});
