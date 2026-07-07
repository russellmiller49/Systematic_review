import { test, expect } from "@playwright/test";
import { signIn, openDemoProject, DEMO } from "./helpers";

// Authorization smoke: route guards + role-gated UI.

test("unauthenticated access redirects to sign-in", async ({ page }) => {
  await page.goto("/orgs");
  await expect(page).toHaveURL(/\/sign-in/);

  await page.goto("/projects/does-not-exist-anyway");
  await expect(page).toHaveURL(/\/sign-in/);
});

test("a reviewer cannot configure screening assignments", async ({ page }) => {
  await signIn(page, DEMO.reviewer1);
  const projectId = await openDemoProject(page);

  await page.goto(`/projects/${projectId}/screening`);
  // Reviewers can screen…
  await expect(page.getByRole("heading", { name: "Screening" })).toBeVisible();
  // …but the assign action (screening.configure — OWNER/ADMIN only) must not be offered.
  await expect(page.getByRole("button", { name: /assign reviewers/i })).toHaveCount(0);
});
