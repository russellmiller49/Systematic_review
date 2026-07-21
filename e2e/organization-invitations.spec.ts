import { expect, test } from "@playwright/test";
import { DEMO, DEMO_PASSWORD, expectNoErrorOverlay, signIn } from "./helpers";

test("organization invite unlocks account creation and beta tester project ownership", async ({
  page,
  browser,
}) => {
  const stamp = Date.now();
  const inviteeEmail = `beta-${stamp}@test.local`;

  await signIn(page, DEMO.owner);
  await page
    .getByRole("link", { name: /Interventional Pulmonology Evidence Group/i })
    .click();
  await page.waitForURL(/\/orgs\/[^/]+$/);

  await page.getByRole("button", { name: /invite member/i }).click();
  await page.fill("#org-invitation-email", inviteeEmail);
  await page.selectOption("#org-invitation-role", "MEMBER");
  await page.getByRole("button", { name: /create invitation/i }).click();

  const invitationDialog = page.getByRole("dialog");
  await expect(invitationDialog.getByRole("heading", { name: /invitation link/i })).toBeVisible();
  const invitationPath = (await invitationDialog.locator("code").textContent())?.trim();
  expect(invitationPath).toMatch(/^\/organization-invitations\/[A-Za-z0-9_-]{43}$/);

  const testerContext = await browser.newContext();
  const testerPage = await testerContext.newPage();
  await testerPage.goto(invitationPath!);
  await testerPage.getByRole("link", { name: /create account/i }).click();
  await testerPage.fill("#name", "Invited Beta Tester");
  await testerPage.fill("#email", inviteeEmail);
  await testerPage.fill("#password", DEMO_PASSWORD);
  await testerPage.getByRole("button", { name: /create account/i }).click();

  await testerPage.waitForURL(/\/organization-invitations\//, { timeout: 30_000 });
  await testerPage.getByRole("button", { name: /accept organization invitation/i }).click();
  await testerPage.waitForURL(/\/orgs\/[^/]+$/, { timeout: 30_000 });
  const invitedMemberRow = testerPage
    .getByRole("row")
    .filter({ hasText: "Invited Beta Tester" });
  await expect(invitedMemberRow).toContainText("Member / beta tester");

  await testerPage.getByRole("button", { name: /new project/i }).click();
  await testerPage.fill("#p-title", `Beta tester project ${stamp}`);
  await testerPage.getByRole("button", { name: /create project/i }).click();
  await testerPage.waitForURL(/\/projects\/[^/]+$/, { timeout: 30_000 });
  await testerPage.getByRole("link", { name: "Settings", exact: true }).click();
  await expect(testerPage.getByText("Invited Beta Tester", { exact: true })).toBeVisible();
  await expect(testerPage.getByText("Owner", { exact: true }).first()).toBeVisible();

  await expectNoErrorOverlay(page);
  await expectNoErrorOverlay(testerPage);
  await testerContext.close();
});
