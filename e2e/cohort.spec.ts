import { expect, test } from "@playwright/test";
import { signIn, openDemoProject, expectNoErrorOverlay, DEMO } from "./helpers";

// Wave 3C: companion-report (cohort-overlap) detection against the seeded demo. The seed
// ships a 24-month follow-up of the Criner (LIBERATE) cohort that is full-text-included
// but not yet study-linked and shares the trial-registry id NCT01796392 with the Criner
// study. Detection tier-1 matches the pair; linking it adds the follow-up report into the
// existing Criner study (Case 1).
test("detects and links the seeded companion report", async ({ page }) => {
  await signIn(page, DEMO.owner);
  const projectId = await openDemoProject(page);
  await page.goto(`/projects/${projectId}/extraction`);

  await page.getByRole("tab", { name: "Companions" }).click();
  await expect(page.getByRole("heading", { name: /Companion reports/i })).toBeVisible();

  // Run detection — the seeded pair surfaces with its shared-registry evidence chip.
  // Both the header action and the empty-state CTA carry this label — take the first.
  await page.getByRole("button", { name: /Run detection/i }).first().click();
  const nctChip = page.getByText(/NCT01796392 shared/i).first();
  await expect(nctChip).toBeVisible({ timeout: 30_000 });

  // The candidate card previews the Case-1 action and offers Link.
  await expect(page.getByText(/Will add report to study Criner 2018/i)).toBeVisible();

  await page.getByRole("button", { name: /^Link$/ }).first().click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByText(/Link companion reports\?/i)).toBeVisible();
  await dialog.getByRole("button", { name: /Confirm link/i }).click();

  // Success toast, then the candidate leaves the suggested list.
  await expect(page.getByText(/Companion reports linked/i)).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText(/NCT01796392 shared/i)).toHaveCount(0, { timeout: 30_000 });

  // It reappears under the decided filter as LINKED.
  await page.getByRole("button", { name: /Show decided/i }).click();
  await expect(page.getByText("linked", { exact: true })).toBeVisible();

  await expectNoErrorOverlay(page);
});
