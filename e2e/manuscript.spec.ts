import { test, expect, type Browser, type Page } from "@playwright/test";
import { signIn, openDemoProject, expectNoErrorOverlay, DEMO } from "./helpers";

// Two-user manuscript flow on the seeded project: the assignee edits their section under
// a lock, the owner sees live presence, comments flow both ways, and the DOCX export
// endpoint responds. Reviewer1 is seeded as the RESULTS assignee.

async function openManuscript(page: Page): Promise<string> {
  const projectId = await openDemoProject(page);
  await page.getByRole("link", { name: "Manuscript", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Manuscript" })).toBeVisible();
  return projectId;
}

async function newSession(browser: Browser, email: string) {
  const context = await browser.newContext();
  const page = await context.newPage();
  await signIn(page, email);
  return { context, page };
}

test("assignee edits under lock; owner sees presence; comments thread works", async ({
  browser,
}) => {
  test.setTimeout(120_000);
  const owner = await newSession(browser, DEMO.owner);
  const reviewer = await newSession(browser, DEMO.reviewer1);

  // Owner opens the manuscript — seeded content renders.
  const projectId = await openManuscript(owner.page);
  await expect(owner.page.getByText("Sections", { exact: true })).toBeVisible();
  await expect(owner.page.getByRole("button", { name: "Introduction" })).toBeVisible();

  // Reviewer1 opens their assigned Results section and starts editing.
  await openManuscript(reviewer.page);
  await reviewer.page.getByRole("button", { name: /^Results/ }).click();
  await expect(
    reviewer.page.getByText("Seven reports met eligibility", { exact: false }),
  ).toBeVisible();
  await reviewer.page.getByRole("button", { name: "Edit", exact: true }).click();
  await expect(reviewer.page.getByRole("button", { name: "Done editing" })).toBeVisible();

  // Type a sentence; autosave indicator reaches Saved.
  await reviewer.page.locator(".ProseMirror").click();
  await reviewer.page.keyboard.press("End");
  await reviewer.page.keyboard.type(" Sensitivity analyses were consistent.");
  await expect(reviewer.page.getByText(/^(Saved|Saving…)$/)).toBeVisible({ timeout: 15_000 });
  await expect(reviewer.page.getByText("Saved", { exact: true })).toBeVisible({ timeout: 15_000 });

  // Owner selects Results and sees the lock presence (10s poll → wait generously).
  await owner.page.getByRole("button", { name: /^Results/ }).click();
  await expect(owner.page.getByText(/is editing this section/)).toBeVisible({ timeout: 30_000 });
  await expect(owner.page.getByRole("button", { name: "Edit", exact: true })).toHaveCount(0);

  // Reviewer finishes; owner can edit again after the next poll.
  await reviewer.page.getByRole("button", { name: "Done editing" }).click();
  await expect(reviewer.page.getByRole("button", { name: "Edit", exact: true })).toBeVisible();
  await expect(owner.page.getByRole("button", { name: "Edit", exact: true })).toBeVisible({
    timeout: 30_000,
  });

  // Comments: reviewer posts with a mention; owner sees it and replies; reviewer resolves.
  await reviewer.page.getByPlaceholder(/Comment on this section/).fill("Ready for stats review?");
  await reviewer.page.getByRole("button", { name: "Mention" }).click();
  await reviewer.page.getByRole("button", { name: /Olivia Owner/ }).click();
  await reviewer.page.getByRole("button", { name: "Comment", exact: true }).click();
  await expect(reviewer.page.getByText("Ready for stats review?")).toBeVisible();

  await expect(owner.page.getByText("Ready for stats review?")).toBeVisible({ timeout: 30_000 });
  await owner.page.getByRole("button", { name: "Reply", exact: true }).first().click();
  await owner.page.getByPlaceholder("Reply…").fill("Yes — running the numbers today.");
  await owner.page.getByRole("button", { name: "Reply", exact: true }).nth(1).click();
  await expect(owner.page.getByText("running the numbers today", { exact: false })).toBeVisible();

  // Owner's mention notification reached the bell (badge shows ≥1).
  await owner.page.getByRole("button", { name: /Notifications/ }).click();
  await expect(
    owner.page.getByText(/mentioned you in a manuscript comment/).first(),
  ).toBeVisible({ timeout: 15_000 });
  await owner.page.keyboard.press("Escape");

  // Version history recorded the reviewer's session.
  await reviewer.page.getByRole("button", { name: "History" }).click();
  await expect(reviewer.page.getByText(/Session end|Saved version/).first()).toBeVisible();
  await reviewer.page.keyboard.press("Escape");

  // DOCX export responds with a document (fetch inside the authed page context).
  const status = await owner.page.evaluate(async (pid) => {
    const res = await fetch(`/api/projects/${pid}/manuscript/export/docx`);
    return { ok: res.ok, type: res.headers.get("content-type") ?? "" };
  }, projectId);
  expect(status.ok).toBe(true);
  expect(status.type).toContain("wordprocessingml");

  await expectNoErrorOverlay(owner.page);
  await expectNoErrorOverlay(reviewer.page);
  await owner.context.close();
  await reviewer.context.close();
});
