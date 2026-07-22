import { test, expect } from "@playwright/test";
import { signIn, openDemoProject, expectNoErrorOverlay, DEMO } from "./helpers";

// Reference library: seeded entries render, manual add works, the bibliography panel
// formats in multiple styles, and exports are reachable. External lookup tabs are NOT
// exercised (no network in e2e).

test("reference library: list, add manually, format bibliography", async ({ page }) => {
  await signIn(page, DEMO.owner);
  const projectId = await openDemoProject(page);

  await page.getByRole("link", { name: "References", exact: true }).click();
  await expect(page.getByRole("heading", { name: "References" })).toBeVisible();

  // Seeded entries: mirrored included studies + 2 methods refs.
  await expect(page.getByText("The PRISMA 2020 statement", { exact: false }).first()).toBeVisible({
    timeout: 30_000,
  });
  await expect(page.getByText("included study").first()).toBeVisible();

  // Add a reference through the Manual tab.
  await page.getByRole("button", { name: "Add reference" }).click();
  await page.getByRole("tab", { name: "Manual" }).click();
  await page.getByLabel("Title").fill("A hand-entered methods paper");
  await page.getByPlaceholder("Family name").first().fill("Handel");
  await page.getByPlaceholder("Given name(s)").first().fill("Georg");
  await page.getByLabel("Year").fill("2015");
  await page.getByLabel("Journal / container").fill("Journal of Manual Entry");
  await page.getByRole("button", { name: "Add reference" }).last().click();
  await expect(page.getByText("Reference added")).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "A hand-entered methods paper" }),
  ).toBeVisible();

  // Bibliography panel formats and switches styles.
  await expect(page.getByRole("heading", { name: "Formatted bibliography" })).toBeVisible();
  await expect(page.getByText("Handel", { exact: false }).last()).toBeVisible();
  await page.getByLabel("Citation style").selectOption("apa");
  await expect(page.getByText("Handel, G.", { exact: false })).toBeVisible({ timeout: 15_000 });

  // Export menu lists interop formats.
  await page.getByRole("button", { name: "Export" }).click();
  await expect(page.getByRole("button", { name: /RIS \(EndNote, Zotero, Mendeley\)/ })).toBeVisible();
  await page.keyboard.press("Escape");

  expect(page.url()).toContain(`/projects/${projectId}/references`);
  await expectNoErrorOverlay(page);
});
