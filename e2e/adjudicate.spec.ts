import { test, expect } from "@playwright/test";
import { signIn, openDemoProject, expectNoErrorOverlay, DEMO } from "./helpers";

// The adjudicator resolves the seeded open title/abstract conflict through the UI.
test("adjudicator resolves the open screening conflict", async ({ page }) => {
  await signIn(page, DEMO.adjudicator);
  const projectId = await openDemoProject(page);

  await page.goto(`/projects/${projectId}/conflicts`);
  await expect(page.getByRole("heading", { name: /conflicts/i })).toBeVisible();

  // The seed leaves exactly one OPEN conflict; its card exposes an Adjudicate action.
  const adjudicate = page.getByRole("button", { name: /adjudicate/i }).first();
  await expect(adjudicate).toBeVisible({ timeout: 30_000 });
  await adjudicate.click();

  const dialog = page.getByRole("dialog");
  await expect(dialog.getByText(/Adjudicate conflict/i)).toBeVisible();
  // The decision radios are visually a labelled card with an sr-only input — click the label.
  await dialog.getByText("Include", { exact: true }).click();
  await page.fill("#adj-rationale", "On full review of the abstract this is an eligible trial.");
  await dialog.getByRole("button", { name: /record decision/i }).click();

  await expect(page.getByText(/Conflict resolved/i)).toBeVisible({ timeout: 30_000 });
  await expectNoErrorOverlay(page);
});
