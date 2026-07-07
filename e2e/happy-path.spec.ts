import { test, expect } from "@playwright/test";
import { signUp, expectNoErrorOverlay } from "./helpers";

// A brand-new user goes from sign-up all the way to an export, entirely through the UI:
// create org → create project → import RIS → assign self → screen → PRISMA → export.
// Single-reviewer project keeps the flow to one browser session.

const RIS = [
  "TY  - JOUR\nTI  - Alpha randomized trial of endobronchial valves\nAU  - Smith, John\nPY  - 2020\nJO  - Journal of Chest Medicine\nAB  - A randomized controlled trial of valves.\nER  - ",
  "TY  - JOUR\nTI  - Beta observational cohort of coils\nAU  - Doe, Jane\nPY  - 2021\nJO  - Respiratory Reports\nAB  - Observational study of coils.\nER  - ",
  "TY  - JOUR\nTI  - Gamma narrative review of lung volume reduction\nAU  - Roe, Richard\nPY  - 2019\nJO  - Reviews in Pulmonology\nAB  - A narrative review.\nER  - ",
].join("\n");

test("sign-up to export, entirely through the UI", async ({ page }) => {
  const ts = Date.now();
  const email = `e2e-${ts}@test.local`;

  // 1. Register.
  await signUp(page, "E2E Tester", email);

  // 2. Create an organization.
  await page.getByRole("button", { name: /new organization/i }).click();
  const orgName = `E2E Review Org ${ts}`;
  await page.fill("#org-name", orgName);
  await page.getByRole("button", { name: /^create$/i }).click();
  const orgCard = page.getByRole("link", { name: new RegExp(orgName) });
  await expect(orgCard).toBeVisible();

  // 3. Open the org and create a single-reviewer project.
  await orgCard.click();
  await page.waitForURL(/\/orgs\/[^/]+$/);
  await page.getByRole("button", { name: /new project/i }).click();
  await page.fill("#p-title", "E2E valves review");
  await page.getByLabel(/Dual screening/i).uncheck();
  await page.getByRole("button", { name: /create project/i }).click();
  await page.waitForURL(/\/projects\/[^/]+$/, { timeout: 30_000 });
  const projectId = page.url().match(/\/projects\/([^/?]+)/)![1];

  // 4. Import a small RIS file.
  await page.getByRole("link", { name: "Import", exact: true }).click();
  await page.waitForURL(new RegExp(`/projects/${projectId}/import`));
  await page.getByRole("button", { name: /add source/i }).click();
  await page.fill("#src-name", "PubMed");
  await page.getByRole("button", { name: /create source/i }).click();
  await expect(page.getByText(/Source created/i)).toBeVisible();

  await page.getByRole("button", { name: /new import/i }).first().click();
  await page.selectOption("#imp-format", "RIS");
  await page.setInputFiles("#imp-file", {
    name: "demo.ris",
    mimeType: "application/x-research-info-systems",
    buffer: Buffer.from(RIS, "utf8"),
  });
  await page.getByRole("button", { name: /upload.*preview/i }).click();

  // Preview → commit.
  const commitBtn = page.getByRole("button", { name: /commit \d+ record/i });
  await expect(commitBtn).toBeVisible({ timeout: 30_000 });
  await commitBtn.click();
  await expect(page.getByText(/3 citations created/i).first()).toBeVisible({ timeout: 30_000 });

  // 5. Assign myself and screen every citation.
  await page.getByRole("link", { name: "Screening", exact: true }).click();
  await page.waitForURL(new RegExp(`/projects/${projectId}/screening`));
  await page.getByRole("button", { name: /assign reviewers/i }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("checkbox").first().check();
  await dialog.getByRole("button", { name: /^assign$/i }).click();
  await expect(page.getByText(/assignments? created/i)).toBeVisible({ timeout: 30_000 });

  // Keyboard-first: include each citation with the "i" shortcut.
  for (let i = 0; i < 3; i++) {
    await expect(page.getByText(/Citation \d+ of/i)).toBeVisible({ timeout: 15_000 });
    await page.keyboard.press("i");
  }
  await expect(page.getByText(/Queue clear/i)).toBeVisible({ timeout: 15_000 });

  // 6. PRISMA reflects the imported + screened counts.
  await page.getByRole("link", { name: "PRISMA", exact: true }).click();
  await page.waitForURL(new RegExp(`/projects/${projectId}/prisma`));
  await expect(page.getByText("Records identified")).toBeVisible({ timeout: 30_000 });
  const identifiedBox = page
    .getByText("Records identified", { exact: true })
    .locator("xpath=ancestor::div[1]");
  await expect(identifiedBox).toContainText("3");
  await expect(page.getByText("Records screened")).toBeVisible();

  // 7. Create an export and confirm it becomes downloadable.
  await page.getByRole("button", { name: /create export/i }).click();
  await expect(page.getByText(/Export ready/i)).toBeVisible({ timeout: 30_000 });
  await expect(page.getByRole("link", { name: /download/i }).first()).toBeVisible();

  await expectNoErrorOverlay(page);
});
